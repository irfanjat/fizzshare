# coturn — pinned official image + a self-signed TLS keypair so the
# turns: (5349) listener works without buying a certificate in dev.
# The REST shared secret is deliberately NOT baked in here: Compose passes it
# on the command line (--static-auth-secret) so no secret lives in the image.
#
# The base image runs as USER nobody and its docker-entrypoint.sh evals every
# arg (which is how image-level --external-ip=$(detect-external-ip) works);
# we keep that entrypoint untouched and only add certs readable by nobody.
FROM coturn/coturn:4.6.2

USER root
RUN openssl req -x509 -newkey rsa:2048 \
      -keyout /etc/coturn/priv.pem -out /etc/coturn/cert.pem \
      -days 3650 -nodes -subj "/CN=peershare" \
 && chmod 644 /etc/coturn/priv.pem /etc/coturn/cert.pem

USER nobody