# lxserver bounded playback probe

Add a bounded audio-byte probe to lxserver so the merged source can verify FLAC format and bit depth inside its custom-source VM.

lxserver 2.1.4 does not expose streaming fetch in that VM. With HEAD alone, the merged source enables ordinary audio; HEAD cannot establish the actual codec. This integration adds `lx.utils.audioProbe` to the compiled CommonJS host.

## Install into an existing host

Run these commands from the my-lxsource repository. Replace the host path with the compiled `userApi.js` in your installation:

```sh
node integrations/lxserver/install-probe.mjs /path/to/lxserver/server/server/sources/userApi.js
node integrations/lxserver/install-probe.mjs /path/to/lxserver/server/server/sources/userApi.js --check
```

The installer validates the host layout and JavaScript syntax, creates a backup beside the file, copies the broker and adds its property to `lxUtils`. Re-running updates the broker without duplicating the property. Unknown layouts and a different existing `audioProbe` implementation are left intact.

`--check` is read-only and returns failure for a missing or outdated installation. Restart lxserver after installation, then re-import the current [merged source](../../README.md).

## Keep the probe in a container image

Use your deployment's exact lxserver image and tag as the base. Set `LXSERVER_IMAGE` to that value before running:

```sh
docker build --build-arg LXSERVER_IMAGE="$LXSERVER_IMAGE" \
  -t lxserver-with-audio-probe integrations/lxserver
```

The [Dockerfile](Dockerfile) installs and checks the probe during the build. Its default `LXSERVER_USER_API` path is `/server/server/server/sources/userApi.js`; supply that build argument if your image uses another layout. Deploy the derived image with your existing configuration and data volume.

A manual patch is lost when the container or base image is replaced. Rebuild the derived image when upgrading lxserver.

## Check playback

The merged script automatically selects the probe when it exists. The broker reads at most 4096 bytes, closes the stream when Range is ignored, follows at most five redirects and applies an eight-second total deadline including proxy lookup. It uses lxserver's existing `customSource` proxy setting.

The script still checks HTTP status, rejects HTML/JSON/video, identifies audio magic and validates FLAC metadata. The probe grants neither general fetch nor module access to the custom-source VM. Importing a source script alone cannot install this host integration.

Results for byte and HEAD hosts appear in [playback.md](../../reports/playback.md), with the final script's SHA256.

## Source loaded but absent from the list

Check lxserver's public-source settings. `enablePublicSources: false` hides public sources; public-source restrictions also require a signed-in user or administrator to view the list. After confirming visibility, test a song: successful initialization or a URL response alone does not establish browser playback.

Return to the [documentation index](../../docs/index.md).
