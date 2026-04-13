# Mock Inference Fixtures

`chat.json` is keyed at runtime by the SHA-256 hash of each fixture's
canonicalized `request` object. Canonicalization recursively sorts object
keys and preserves array order, so fixture lookup is stable even if JSON key
order changes in the file.

`embeddings.json` is a golden replay corpus. Its responses must be generated
by calling the committed mock service implementation after any algorithm
change. Do not hand-author or edit vector values.
