-- M5a — pairing-relay + device-bound session mint.
--
-- A paired device row (created ONLY by the daemon's POST /pair/confirm after the desktop confirms)
-- carries the gateway-session jti the phone bound into its pairing Hello. POST /pair/session
-- re-checks bound_session_jti === claims.jti before minting the device-bound (`did`) phone session,
-- which closes a concurrent-session race AND makes the bind single-use (it is cleared on a
-- successful mint, so a replay with the same body can't re-mint). Nullable + additive: getDeviceById
-- (SELECT *) returns it, every existing row reads NULL.
ALTER TABLE devices ADD COLUMN bound_session_jti TEXT;
