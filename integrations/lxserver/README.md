# lxserver bounded playback probe

lxserver 2.1.4 does not expose streaming fetch inside its custom-source VM.
Without this integration, the merged source enables ordinary audio only. HEAD
checks connectivity and explicit error content types; binary/missing MIME and
405/501 are inconclusive. HEAD cannot establish FLAC format or bit depth.

Install the bounded byte probe into the compiled CommonJS host:

```sh
node integrations/lxserver/install-probe.mjs /path/to/lxserver/server/server/sources/userApi.js
node integrations/lxserver/install-probe.mjs /path/to/lxserver/server/server/sources/userApi.js --check
```

The installer checks the host layout and JavaScript syntax before modifying it,
preserves a backup beside the original file, copies the broker, and inserts its
property into `lxUtils`. Re-running it updates the broker without duplicating the
property. `--check` is read-only and fails for a missing or outdated installation.
Unknown layouts or an existing different audioProbe implementation are left alone.
Restart lxserver after installation, then re-import the current merged source.

For a persistent container installation, build a derived image using your exact
existing lxserver image/tag:

```sh
docker build --build-arg LXSERVER_IMAGE=your-existing-lxserver-image:tag \
  -t lxserver-with-audio-probe integrations/lxserver
```

The Dockerfile installs and checks the broker during the build. Its default
`LXSERVER_USER_API` is `/server/server/server/sources/userApi.js`; override that
build argument if your image uses a different layout. Use the derived image in
your existing deployment with the same data volume and configuration.

The merged source will automatically use `lx.utils.audioProbe` when available.
The broker follows at most five redirects, reads at most a 4096-byte prefix into
its result, closes the stream even when Range is ignored, and applies an
eight-second total deadline including proxy lookup. It uses the existing
`customSource` proxy configuration and grants no general fetch or module access
to the custom-source VM. The merged script still checks HTTP status, excludes
HTML/JSON/video, checks audio magic, and checks real FLAC/24-bit metadata.

This is a host integration, not a portable LX API. Importing a custom-source script
cannot install a native broker. Generic clients with streaming fetch can verify
lossless directly; HEAD-only clients expose 128k/320k. A container recreation or
image upgrade removes a manual patch; rebuild the derived image when upgrading.
The project exercises both host modes and publishes `reports/playback.md` with
the final script's SHA256 and per-song playback results.

The settings page can also hide a correctly loaded public source:
`enablePublicSources: false` filters it out. Public-source restriction additionally
requires an authenticated user or administrator to view the list. Neither a
successful source initialization nor a successful URL response guarantees that
the browser will actually play it; test the returned audio path as well.
