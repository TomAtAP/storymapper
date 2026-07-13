"use strict";

/**
 * storymap — graph algorithms.
 *
 * SINGLE SOURCE OF TRUTH lives in shared/core/graph.js (UMD). Thin re-export
 * so server-side requires keep working. Edit shared/core/graph.js, never this
 * file. (SM-139)
 */
module.exports = require("../../shared/core/graph.js");
