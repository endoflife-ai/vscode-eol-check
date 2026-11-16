# Changelog

## 1.0.2

The endoflife.ai API has needed a key for every lookup since November 16, 2026. Before this release a missing or refused key left files with no marks at all, so an end-of-life version looked the same as a clean file.

- A version pin that could not be checked now gets a blue note (information) that says why: no key is set, the key was refused, the key's daily limit was reached, endoflife.ai does not track that version, or the API gave no answer.
- New status bar item: `EOL: on`, `EOL: key needed`, `EOL: limit reached` or `EOL: off`. Click it to open the key setting.
- The one-time message about the key now has two buttons: Open Setting and Get Free Key.
- A failed lookup is no longer cached. Open files are checked again as soon as a setting changes, so a new key takes effect at once.
- No request is sent when no key is set.
- Turning the extension off (`endoflifeAi.enabled`) now clears its marks.
- README and setting description: a key is required. A free key gives 150 requests a day and does not expire: https://endoflife.ai/api#free-key
