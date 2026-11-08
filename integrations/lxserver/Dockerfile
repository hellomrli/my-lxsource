ARG LXSERVER_IMAGE
FROM ${LXSERVER_IMAGE}
COPY audio-probe.cjs install-probe.mjs /opt/my-lxsource-probe/
ARG LXSERVER_USER_API=/server/server/server/sources/userApi.js
RUN node /opt/my-lxsource-probe/install-probe.mjs "${LXSERVER_USER_API}" \
    && node /opt/my-lxsource-probe/install-probe.mjs "${LXSERVER_USER_API}" --check
