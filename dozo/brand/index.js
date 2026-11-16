// Node 24 runs `node --test dozo/brand/` by resolving the directory as a module, so this shim
// makes that command run the tests. `node --test "dozo/brand/*.test.mjs"` works without it.
import("./brand.test.mjs");
