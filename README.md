# StreamLift

StreamLift adds a wide **Download video** button above supported players in desktop Chrome. The extension menu shows the current site, detected sources, and download progress.

[Download StreamLift v1.1.0 for Chrome](https://github.com/syntaxsurge/streamlift/releases/download/v1.1.0/streamlift-1.1.0.zip)

## Install from the ZIP

1. Extract the ZIP to a folder you can keep.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked**, then choose the extracted `streamlift` folder containing `manifest.json`.
4. Reload any open video pages on supported sites.

Share the ZIP with friends to install using the same steps. StreamLift uses Chrome 119 or later.

## Supported sites

| Website | Sources |
| --- | --- |
| PinayTG | Direct MP4, Garpf embeds, and detected HLS |
| LootedPinay | Clean Tube player embeds and their exposed MP4 or HLS sources |
| Garpf | Embedded and directly opened supported player pages |

**Automatic** tries a direct MP4 first. Use the source selector to choose a particular player. For supported HLS streams, StreamLift selects the highest available resolution and uses bitrate to break ties. MPEG-TS streams save as `.ts`. Fragmented MP4 streams save as `.mp4`. Keep the video tab open until saving begins.

## Popup protection

The download bar uses Chrome's top layer to sit above ordinary page overlays. StreamLift blocks script-opened windows and auxiliary tabs from supported pages, hides recognized ad overlays, and blocks known ad requests originating from those sites. The Download button starts a Chrome download from the current tab.

## Compatibility

HLS support covers complete, unencrypted video streams with compatible audio and video in the same stream. Large HLS downloads are assembled in browser memory. If a media host needs access, open the extension menu, allow the displayed host, and retry.

## Adding a site

Add the site to the manifest's host and script matches, the background page check in `common.js`, and the popup's supported sites. Add its player metadata reader to `shared-discovery.js`. Keep any additional popup protections scoped to the supported site's behavior.

[Chrome extension installation guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
