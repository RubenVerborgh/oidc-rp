'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

/**
 * Dependencies
 */
var URL = require('urlutils');
var assert = require('assert');
var crypto = require('webcrypto');
var base64url = require('base64url');
var fetch = require('node-fetch');
var Headers = fetch.Headers ? fetch.Headers : global.Headers;
var FormUrlEncoded = require('./FormUrlEncoded');
var IDToken = require('./IDToken');
//const AccessToken = require('./AccessToken')

/**
 * AuthenticationResponse
 */

var AuthenticationResponse = function () {
  function AuthenticationResponse() {
    _classCallCheck(this, AuthenticationResponse);
  }

  _createClass(AuthenticationResponse, null, [{
    key: 'validateResponse',


    /**
     * validateResponse
     *
     * @description
     * Authentication response validation.
     *
     * @param {string|Object} response
     * @returns {Promise}
     */
    value: function validateResponse(response) {
      return Promise.resolve(response).then(this.parseResponse).then(this.matchRequest).then(this.validateStateParam).then(this.errorResponse).then(this.validateResponseMode).then(this.validateResponseParams).then(this.exchangeAuthorizationCode).then(this.validateIDToken).then(function () {
        // what kind of response object?
        // instance of AuthenticationRequest?
        return response;
      });
    }

    /**
     * parseResponse
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'parseResponse',
    value: function parseResponse(response) {
      var redirect = response.redirect,
          body = response.body;

      // response must be either a redirect uri or request body, but not both

      if (redirect && body || !redirect && !body) {
        throw new Error('Invalid response mode');
      }

      // parse redirect uri
      if (redirect) {
        var url = new URL(redirect);
        var search = url.search,
            hash = url.hash;


        if (search && hash) {
          throw new Error('Invalid response mode');
        }

        if (search) {
          response.params = FormUrlEncoded.decode(search.substring(1));
          response.mode = 'query';
        }

        if (hash) {
          response.params = FormUrlEncoded.decode(hash.substring(1));
          response.mode = 'fragment';
        }
      }

      // parse request form body
      if (body) {
        response.params = FormUrlEncoded.decode(body);
        response.mode = 'form_post';
      }

      return response;
    }

    /**
     * matchRequest
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'matchRequest',
    value: function matchRequest(response) {
      var rp = response.rp,
          params = response.params,
          session = response.session;

      var state = params.state;
      var issuer = rp.provider.configuration.issuer;

      if (!state) {
        throw new Error('Missing state parameter in authentication response');
      }

      var key = issuer + '/requestHistory/' + state;
      var request = session[key];

      if (!request) {
        throw new Error('Mismatching state parameter in authentication response');
      }

      response.request = JSON.parse(request);
      return response;
    }

    /**
     * validateStateParam
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'validateStateParam',
    value: function validateStateParam(response) {
      var octets = new Uint8Array(response.request.state);
      var encoded = response.params.state;

      return crypto.subtle.digest({ name: 'SHA-256' }, octets).then(function (digest) {
        if (encoded !== base64url(Buffer.from(digest))) {
          throw new Error('Mismatching state parameter in authentication response');
        }

        return response;
      });
    }

    /**
     * errorResponse
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'errorResponse',
    value: function errorResponse(response) {
      var error = response.params.error;

      if (error) {
        return Promise.reject(error);
      }

      return Promise.resolve(response);
    }

    /**
     * validateResponseMode
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'validateResponseMode',
    value: function validateResponseMode(response) {
      if (response.request.response_type !== 'code' && response.mode === 'query') {
        throw new Error('Invalid response mode');
      }

      return response;
    }

    /**
     * validateResponseParams
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'validateResponseParams',
    value: function validateResponseParams(response) {
      var request = response.request,
          params = response.params;

      var expectedParams = request.response_type.split(' ');

      if (expectedParams.includes('code')) {
        assert(params.code, 'Missing authorization code in authentication response');
        // TODO assert novelty of code
      }

      if (expectedParams.includes('id_token')) {
        assert(params.id_token, 'Missing id_token in authentication response');
      }

      if (expectedParams.includes('token')) {
        assert(params.access_token, 'Missing access_token in authentication response');

        assert(params.token_type, 'Missing token_type in authentication response');
      }

      return response;
    }

    /**
     * exchangeAuthorizationCode
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'exchangeAuthorizationCode',
    value: function exchangeAuthorizationCode(response) {
      var rp = response.rp,
          params = response.params,
          request = response.request;

      var code = params.code;

      // only exchange the authorization code when the response type is "code"
      if (!code || request['response_type'] !== 'code') {
        return Promise.resolve(response);
      }

      var provider = rp.provider,
          registration = rp.registration;

      var id = registration['client_id'];
      var secret = registration['client_secret'];

      // verify the client is not public
      if (!secret) {
        throw new AuthenticationError('Client cannot exchange authorization code because ' + 'it is not a confidential client');
      }

      // initialize token request arguments
      var endpoint = provider.configuration.token_endpoint;
      var method = 'POST';

      // initialize headers
      var headers = new Headers({
        'Content-Type': 'application/x-www-form-urlencoded'
      });

      // initialize the token request parameters
      var body = FormUrlEncoded.encode({
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': request['redirect_uri']
      });

      // determine client authentication method
      var authMethod = registration['token_endpoint_auth_method'] || 'client_secret_basic';

      // client secret basic authentication
      if (authMethod === 'client_secret_basic') {
        var credentials = new Buffer(id + ':' + secret).toString('base64');
        headers.set('Authorization', 'Basic ' + credentials);
      }

      // client secret post authentication
      if (authMethod === 'client_secret_post') {
        body['client_id'] = id;
        body['client_secret'] = secret;
      }

      // TODO
      // client_secret_jwt authentication
      // private_key_jwt

      // make the token request
      return fetch(endpoint, { method: method, headers: headers, body: body }).then(function (tokenResponse) {
        return tokenResponse.json();
      }).then(function (tokenResponse) {
        assert(tokenResponse['access_token'], 'Missing access_token in token response');

        assert(tokenResponse['token_type'], 'Missing token_type in token response');

        assert(tokenResponse['id_token'], 'Missing id_token in token response');

        // anything else?

        // IS THIS THE RIGHT THING TO DO HERE?
        response.params = Object.assign(response.params, tokenResponse);
        return response;
      });
    }

    /**
     * validateIDToken
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'validateIDToken',
    value: function validateIDToken(response) {
      var jwt = response.params.id_token;

      // only validate the ID Token if present in the response
      if (!jwt) {
        return Promise.resolve(response);
      }

      var _response$rp = response.rp,
          provider = _response$rp.provider,
          registration = _response$rp.registration;
      var configuration = provider.configuration,
          jwks = provider.jwks;


      return Promise.resolve(response).then(AuthenticationResponse.decryptIDToken).then(AuthenticationResponse.decodeIDToken).then(AuthenticationResponse.validateIssuer).then(AuthenticationResponse.validateAudience).then(AuthenticationResponse.resolveKeys).then(AuthenticationResponse.verifySignature).then(AuthenticationResponse.validateExpires).then(AuthenticationResponse.verifyNonce).then(AuthenticationResponse.validateACR).then(AuthenticationResponse.validateAuthTime).then(AuthenticationResponse.validateAccessTokenHash).then(AuthenticationResponse.validateCodeHash);
    }

    /**
     * decryptIDToken
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'decryptIDToken',
    value: function decryptIDToken(response) {
      // TODO
      return Promise.resolve(response);
    }

    /**
     * decodeIDToken
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'decodeIDToken',
    value: function decodeIDToken(response) {
      var jwt = response.params.id_token;

      if (jwt) {
        response.decoded = IDToken.decode(jwt);
      }

      return response;
    }

    /**
     * validateIssuer
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'validateIssuer',
    value: function validateIssuer(response) {
      var configuration = response.rp.provider.configuration;
      var payload = response.decoded.payload;

      // validate issuer of token matches this relying party's provider
      if (payload.iss !== configuration.issuer) {
        throw new Error('Mismatching issuer in ID Token');
      }

      return response;
    }

    /**
     * validateAudience
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'validateAudience',
    value: function validateAudience(response) {
      var registration = response.rp.registration;
      var _response$decoded$pay = response.decoded.payload,
          aud = _response$decoded$pay.aud,
          azp = _response$decoded$pay.azp;

      // validate audience includes this relying party

      if (typeof aud === 'string' && aud !== registration['client_id']) {
        throw new Error('Mismatching audience in id_token');
      }

      // validate audience includes this relying party
      if (Array.isArray(aud) && !aud.includes(registration['client_id'])) {
        throw new Error('Mismatching audience in id_token');
      }

      // validate authorized party is present if required
      if (Array.isArray(aud) && !azp) {
        throw new Error('Missing azp claim in id_token');
      }

      // validate authorized party is this relying party
      if (azp && azp !== registration['client_id']) {
        throw new Error('Mismatching azp claim in id_token');
      }

      return response;
    }

    /**
     * resolveKeys
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'resolveKeys',
    value: function resolveKeys(response) {
      var rp = response.rp;
      var provider = rp.provider;
      var jwks = provider.jwks;
      var decoded = response.decoded;

      //if (decoded.resolveKeys(jwks)) {
      //  return Promise.resolve(response)
      //}

      return rp.jwks().then(function (jwks) {
        if (decoded.resolveKeys(jwks)) {
          return Promise.resolve(response);
        } else {
          throw new Error('Cannot resolve signing key for ID Token.');
        }
      });
    }

    /**
     * verifySignature
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'verifySignature',
    value: function verifySignature(response) {
      var alg = response.decoded.header.alg;
      var registration = response.rp.registration;
      var expectedAlgorithm = registration['id_token_signed_response_alg'] || 'RS256';

      // validate signing algorithm matches expectation
      if (alg !== expectedAlgorithm) {
        throw new Error('Expected ID Token to be signed with ' + expectedAlgorithm);
      }

      return response.decoded.verify().then(function (verified) {
        if (!verified) {
          throw new Error('Invalid ID Token signature');
        }

        return response;
      });
    }

    /**
     * validateExpires
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'validateExpires',
    value: function validateExpires(response) {
      var exp = response.decoded.payload.exp;

      // validate expiration of token
      if (exp <= Math.floor(Date.now() / 1000)) {
        throw new Error('Expired ID Token');
      }

      return response;
    }

    /**
     * verifyNonce
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'verifyNonce',
    value: function verifyNonce(response) {
      var octets = new Uint8Array(response.request.nonce);
      var nonce = response.decoded.payload.nonce;

      if (!nonce) {
        throw new Error('Missing nonce in ID Token');
      }

      return crypto.subtle.digest({ name: 'SHA-256' }, octets).then(function (digest) {
        if (nonce !== base64url(Buffer.from(digest))) {
          throw new Error('Mismatching nonce in ID Token');
        }

        return response;
      });
    }

    /**
     * validateAcr
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'validateAcr',
    value: function validateAcr(response) {
      // TODO
      return response;
    }

    /**
     * validateAccessTokenHash
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'validateAccessTokenHash',
    value: function validateAccessTokenHash(response) {
      // TODO
      return response;
    }

    /**
     * validateAuthorizationCodeHash
     *
     * @param {Object} response
     * @returns {Promise}
     */

  }, {
    key: 'validateAuthorizationCodeHash',
    value: function validateAuthorizationCodeHash(response) {
      // TODO
      return response;
    }
  }]);

  return AuthenticationResponse;
}();

/**
 * Export
 */


module.exports = AuthenticationResponse;