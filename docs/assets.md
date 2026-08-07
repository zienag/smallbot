# Avatars and images

Avatars are SVG sources in `.claude.local.temp/` (gitignored), rendered via headless Chrome:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --force-device-scale-factor=1 --window-size=512,512 --screenshot=out.png in.svg
```

`--window-size` must match the SVG's own `width`, and the scale factor multiplies it — a 256-wide source at factor 2 also lands on 512. The background must be an opaque full-square `<rect>`: transparent corners come out as JPEG artifacts in Telegram. Telegram crops avatars round, so keep the visual mass well inside the inscribed circle, and check the mark at 40 px — that is the size it is actually seen at.

Uploads via bot API (`setMyProfilePhoto` / `setChatPhoto`) — use Python multipart; sandboxed curl can't read local files for `-F`. A user account (not a bot) uses Telethon's `UploadProfilePhotoRequest`; see the dev-creds skill for the session.

Show drafts to the owner before uploading anywhere. A contact sheet beats single renders: one HTML page with each candidate round-cropped at 150 px, a 40 px row, and the sibling channel avatars alongside, screenshotted the same way.

Blog-channel avatars use a "drop cap" layout (company logo as an old-book initial, gray text-line bars wrapping around) — don't redraw brand marks by hand, take the official SVGs (Claude spark: claude.com/favicon.svg; OpenAI blossom: saved as blossom-white.svg).

## Don't draw them yourself

Hand-authored SVG reads as clip art and the owner has rejected it as such. Hand the drawing to Codex instead — it is installed and configured for full access, so it can render and look at its own output:

```sh
codex exec -s danger-full-access -i <reference.png> - < brief.md
```

The brief carries the weight: state what the account is, name what is wrong with the current draft, demand four genuinely different takes, list the hard constraints (512×512, opaque square background, round crop, legible at 40 px, no `<text>` — fonts differ per machine), give the render command above, and require it to look at both the 512 and the 40 px PNG and iterate before answering. Ask it to report what it noticed and deliberately did not do.
