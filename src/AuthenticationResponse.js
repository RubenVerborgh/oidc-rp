/**
 * Dependencies
 */
const URL = require('urlutils')
const assert = require('assert')
const crypto = require('@trust/webcrypto')
const base64url = require('base64url')
const fetch = require('node-fetch')
const Headers = fetch.Headers ? fetch.Headers : global.Headers
const FormUrlEncoded = require('./FormUrlEncoded')
const IDToken = require('./IDToken')
const onHttpError = require('./onHttpError')

/**
 * AuthenticationResponse
 */
class AuthenticationResponse {

  /**
   * validateResponse
   *
   * @description
   * Authentication response validation.
   *
   * @param {string|Object} response
   * @returns {Promise}
   */
  static validateResponse (response) {
    return Promise.resolve(response)
      .then(this.parseResponse)
      .then(this.matchRequest)
      .then(this.validateStateParam)
      .then(this.errorResponse)
      .then(this.validateResponseMode)
      .then(this.validateResponseParams)
      .then(this.exchangeAuthorizationCode)
      .then(this.validateIDToken)
      .then(() => {
        // what kind of response object?
        // instance of AuthenticationRequest?
        return response
      })
  }

  /**
   * parseResponse
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static parseResponse (response) {
    let {redirect, body} = response

    // response must be either a redirect uri or request body, but not both
    if ((redirect && body) || (!redirect && !body)) {
      throw new Error('Invalid response mode')
    }

    // parse redirect uri
    if (redirect) {
      let url = new URL(redirect)
      let {search, hash} = url

      if ((search && hash) || (!search && !hash)) {
        throw new Error('Invalid response mode')
      }

      if (search) {
        response.params = FormUrlEncoded.decode(search.substring(1))
        response.mode = 'query'
      }

      if (hash) {
        response.params = FormUrlEncoded.decode(hash.substring(1))
        response.mode = 'fragment'
      }
    }

    // parse request form body
    if (body) {
      response.params = FormUrlEncoded.decode(body)
      response.mode = 'form_post'
    }

    return response
  }

  /**
   * matchRequest
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static matchRequest (response) {
    let {rp, params, session} = response
    let state = params.state
    let issuer = rp.provider.configuration.issuer

    if (!state) {
      throw new Error(
        'Missing state parameter in authentication response')
    }

    let key = `${issuer}/requestHistory/${state}`
    let request = session[key]

    if (!request) {
      throw new Error(
        'Mismatching state parameter in authentication response')
    }

    response.request = JSON.parse(request)
    return response
  }

  /**
   * validateStateParam
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static validateStateParam (response) {
    let octets = new Uint8Array(response.request.state)
    let encoded = response.params.state

    return crypto.subtle.digest({ name: 'SHA-256' }, octets).then(digest => {
      if (encoded !== base64url(Buffer.from(digest))) {
        throw new Error(
          'Mismatching state parameter in authentication response')
      }

      return response
    })
  }

  /**
   * errorResponse
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static errorResponse (response) {
    let error = response.params.error

    if (error) {
      return Promise.reject(error)
    }

    return Promise.resolve(response)
  }

  /**
   * validateResponseMode
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static validateResponseMode (response) {
    if (response.request.response_type !== 'code' && response.mode === 'query') {
      throw new Error('Invalid response mode')
    }

    return response
  }

  /**
   * validateResponseParams
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static validateResponseParams (response) {
    let {request, params} = response
    let expectedParams = request.response_type.split(' ')

    if (expectedParams.includes('code')) {
      assert(params.code,
        'Missing authorization code in authentication response')
      // TODO assert novelty of code
    }

    if (expectedParams.includes('id_token')) {
      assert(params.id_token,
        'Missing id_token in authentication response')
    }

    if (expectedParams.includes('token')) {
      assert(params.access_token,
        'Missing access_token in authentication response')

      assert(params.token_type,
        'Missing token_type in authentication response')
    }

    return response
  }

  /**
   * exchangeAuthorizationCode
   *
   * @param {Object} response
   * @returns {Promise} response object
   */
  static exchangeAuthorizationCode (response) {
    let {rp, params, request} = response
    let code = params.code

    // only exchange the authorization code when the response type is "code"
    if (!code || request['response_type'] !== 'code') {
      return Promise.resolve(response)
    }

    let {provider, registration} = rp
    let id = registration['client_id']
    let secret = registration['client_secret']

    // verify the client is not public
    if (!secret) {
        return Promise.reject(new Error(
          'Client cannot exchange authorization code because ' +
          'it is not a confidential client'))
    }

    // initialize token request arguments
    let endpoint = provider.configuration.token_endpoint
    let method = 'POST'

    // initialize headers
    let headers = new Headers({
      'Content-Type': 'application/x-www-form-urlencoded'
    })

    // initialize the token request parameters
    let bodyContents = {
      'grant_type': 'authorization_code',
      'code': code,
      'redirect_uri': request['redirect_uri']
    }

    // determine client authentication method
    let authMethod = registration['token_endpoint_auth_method']
      || 'client_secret_basic'

    // client secret basic authentication
    if (authMethod === 'client_secret_basic') {
      let credentials = new Buffer(`${id}:${secret}`).toString('base64')
      headers.set('Authorization', `Basic ${credentials}`)
    }

    // client secret post authentication
    if (authMethod === 'client_secret_post') {
      bodyContents['client_id'] = id
      bodyContents['client_secret'] = secret
    }

    let body = FormUrlEncoded.encode(bodyContents)

    // TODO
    // client_secret_jwt authentication
    // private_key_jwt

    // make the token request

    return fetch(endpoint, {method, headers, body})
      .then(onHttpError('Error exchanging authorization code'))
      .then(tokenResponse => tokenResponse.json())
      .then(tokenResponse => {
        assert(tokenResponse['access_token'],
          'Missing access_token in token response')

        assert(tokenResponse['token_type'],
          'Missing token_type in token response')

        assert(tokenResponse['id_token'],
          'Missing id_token in token response')

        // anything else?

        // IS THIS THE RIGHT THING TO DO HERE?
        response.params = Object.assign(response.params, tokenResponse)
        return response
      })
  }


  /**
   * validateIDToken
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static validateIDToken (response) {
    let jwt = response.params.id_token

    // only validate the ID Token if present in the response
    if (!jwt) {
      return Promise.resolve(response)
    }

    let {provider, registration} = response.rp
    let {configuration, jwks} = provider

    return Promise.resolve(response)
      .then(AuthenticationResponse.decryptIDToken)
      .then(AuthenticationResponse.decodeIDToken)
      .then(AuthenticationResponse.validateIssuer)
      .then(AuthenticationResponse.validateAudience)
      .then(AuthenticationResponse.resolveKeys)
      .then(AuthenticationResponse.verifySignature)
      .then(AuthenticationResponse.validateExpires)
      .then(AuthenticationResponse.verifyNonce)
      .then(AuthenticationResponse.validateACR)
      .then(AuthenticationResponse.validateAuthTime)
      .then(AuthenticationResponse.validateAccessTokenHash)
      .then(AuthenticationResponse.validateCodeHash)
  }

  /**
   * decryptIDToken
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static decryptIDToken (response) {
    // TODO
    return Promise.resolve(response)
  }

  /**
   * decodeIDToken
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static decodeIDToken (response) {
    let jwt = response.params.id_token

    if (jwt) {
      response.decoded = IDToken.decode(jwt)
    }

    return response
  }


  /**
   * validateIssuer
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static validateIssuer (response) {
    let configuration = response.rp.provider.configuration
    let payload = response.decoded.payload

    // validate issuer of token matches this relying party's provider
    if (payload.iss !== configuration.issuer) {
      throw new Error('Mismatching issuer in ID Token')
    }

    return response
  }

  /**
   * validateAudience
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static validateAudience (response) {
    let registration = response.rp.registration
    let {aud, azp} = response.decoded.payload

    // validate audience includes this relying party
    if (typeof aud === 'string' && aud !== registration['client_id']) {
      throw new Error('Mismatching audience in id_token')
    }

    // validate audience includes this relying party
    if (Array.isArray(aud) && !aud.includes(registration['client_id'])) {
      throw new Error('Mismatching audience in id_token')
    }

    // validate authorized party is present if required
    if (Array.isArray(aud) && !azp) {
      throw new Error('Missing azp claim in id_token')
    }

    // validate authorized party is this relying party
    if (azp && azp !== registration['client_id']) {
      throw new Error('Mismatching azp claim in id_token')
    }

    return response
  }


  /**
   * resolveKeys
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static resolveKeys (response) {
    let rp = response.rp
    let provider = rp.provider
    let decoded = response.decoded

    return Promise.resolve(provider.jwks)

      .then(jwks => jwks ? jwks : rp.jwks())

      .then(jwks => {
        if (decoded.resolveKeys(jwks)) {
          return Promise.resolve(response)
        } else {
          throw new Error('Cannot resolve signing key for ID Token')
        }
      })
  }

  /**
   * verifySignature
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static verifySignature (response) {
    let alg = response.decoded.header.alg
    let registration = response.rp.registration
    let expectedAlgorithm = registration['id_token_signed_response_alg'] || 'RS256'

    // validate signing algorithm matches expectation
    if (alg !== expectedAlgorithm) {
      throw new Error(
        `Expected ID Token to be signed with ${expectedAlgorithm}`)
    }

    return response.decoded.verify().then(verified => {
      if (!verified) {
        throw new Error('Invalid ID Token signature')
      }

      return response
    })
  }

  /**
   * validateExpires
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static validateExpires (response) {
    let exp = response.decoded.payload.exp

    // validate expiration of token
    if (exp <= Math.floor(Date.now() / 1000)) {
      throw new Error('Expired ID Token')
    }

    return response
  }

  /**
   * verifyNonce
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static verifyNonce (response) {
    let octets = new Uint8Array(response.request.nonce)
    let nonce = response.decoded.payload.nonce

    if (!nonce) {
      throw new Error('Missing nonce in ID Token')
    }

    return crypto.subtle.digest({ name: 'SHA-256' }, octets).then(digest => {
      if (nonce !== base64url(Buffer.from(digest))) {
        throw new Error('Mismatching nonce in ID Token')
      }

      return response
    })
  }

  /**
   * validateAcr
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static validateAcr (response) {
    // TODO
    return response
  }

  /**
   * validateAccessTokenHash
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static validateAccessTokenHash (response) {
    // TODO
    return response
  }

  /**
   * validateAuthorizationCodeHash
   *
   * @param {Object} response
   * @returns {Promise}
   */
  static validateAuthorizationCodeHash (response) {
    // TODO
    return response
  }
}

/**
 * Export
 */
module.exports = AuthenticationResponse
