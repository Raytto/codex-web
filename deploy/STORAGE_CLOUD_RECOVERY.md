# Portable encrypted recovery

This directory may contain encrypted catalogue revisions and content-addressed recovery objects from your Codex Web installation. The metadata file is not the original file. You need your own cloud authorization and the matching age identity, retained independently of this directory.

Use the accompanying versioned `storage-recover-file.py --help` to select an encrypted catalogue and recover one original into a new local destination. Never run a helper from an untrusted source without checking its version/hash. For complete-site recovery, use the matching public Codex Web release and `storage-recovery-cli --help`.

Keep descriptors, encryption identity recovery information and the exact public source revision. Restore into an empty private directory, check byte hashes and SQLite integrity, then start a separate restored instance. Do not overwrite live state or infer success merely from an uploaded archive. The cloud login credential and encryption identity are separate; neither is included in this note.
