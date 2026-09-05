---
'@knowalabs/meridian': patch
---

`meridian sync` no longer mistakes a formatter pass for a hand edit when a generated file holds a table or JSON. The manifest signature that lets sync tell edits from cosmetic rewrites now also ignores table-separator width and all whitespace, so Prettier padding `| --- |` out to the column or spacing a JSON colon no longer freezes the file out of every future refresh. Signatures are written as `sig2:`; a manifest holding `sig1:` signatures keeps working exactly as before until its next run re-records it.
