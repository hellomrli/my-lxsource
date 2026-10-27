# lxserver bounded playback probe

lxserver 2.1.4 does not expose streaming fetch inside its custom-source VM. The
generic HEAD fallback is deliberately conservative, but some real FLAC files
are labelled `audio/mpeg` and some audio CDNs use `application/octet-stream`.
Do not fix this by accepting every HEAD response or assuming a `.flac` URL is
lossless.

Copy `audio-probe.cjs` beside lxserver's compiled
`server/server/sources/userApi.js`. Add this property to its existing `lxUtils`:

```js
audioProbe: require('./audio-probe.cjs')(proxy_js_1.getProxyAgent),
```

Back up the files before changing them and restart only the lxserver process.
The merged source will automatically use `lx.utils.audioProbe` when available.
The broker follows at most five redirects, reads at most a 4096-byte prefix into
its result, closes the stream even when Range is ignored, and applies an
eight-second total deadline including proxy lookup. It uses the existing
`customSource` proxy configuration and grants no general fetch or module access
to the custom-source VM. The merged script still checks HTTP status, excludes
HTML/JSON/video, checks audio magic, and checks real FLAC/24-bit metadata.

This is a host integration, not a portable LX API. Generic LX clients keep the
existing streaming-fetch/HEAD behavior. A container recreation or image upgrade
will remove the host patch unless it is included in your maintained image.

The settings page can also hide a correctly loaded public source:
`enablePublicSources: false` filters it out. Public-source restriction additionally
requires an authenticated user or administrator to view the list. Neither a
successful source initialization nor a successful URL response guarantees that
the browser will actually play it; test the returned audio path as well.
