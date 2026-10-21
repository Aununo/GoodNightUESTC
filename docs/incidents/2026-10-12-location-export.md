# Frontend location binding changes

This retained upstream incident path now records the general engineering lesson without a student's operational timeline or live results.

A minified location export can change after a school frontend release. Hardcoding an old export name may fail even while authentication and other requests still work. The client must stop rather than guess another binding or submit without validated location.

The current browser-location implementation first checks the school's global location API. If unavailable, Acorn parses the current same-origin entry and student modules, resolves the imported binding actually used by the GCJ-02 call, and verifies the entry export. Duplicate options, spreads, computed keys, shadowed imports and ambiguous modules are rejected.

Fixed location is a separate explicit configuration mode. It is not an automatic repair for a changed frontend contract.

Synthetic tests in `test/frontend-contract.test.mjs` and `test/location.test.mjs` cover source resolution and failure behavior. Live account data, measured coordinates, operation times and recovery records should be retained privately.
