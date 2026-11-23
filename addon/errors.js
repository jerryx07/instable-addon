'use strict';

class AddonError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = 'AddonError';
    this.status = status;
    this.statusCode = status;
    this.headers = headers;
  }
}

module.exports = { AddonError };
