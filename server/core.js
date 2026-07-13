"use strict";

/**
 * storymap — core data model.
 *
 * SINGLE SOURCE OF TRUTH lives in shared/core.js (UMD). This is a thin
 * re-export so every server-side require("./core.js") / require("../core.js")
 * keeps working unchanged. Edit shared/core.js, never this file. (SM-139)
 */
module.exports = require("../shared/core.js");
