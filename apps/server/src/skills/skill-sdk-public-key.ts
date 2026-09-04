/**
 * F3-T2 PR2 (ADR-0036 Karar b/c): the Ed25519 public key used to verify
 * skill manifest signatures registered into the process-wide
 * `SkillRegistry` (see `SkillsModule`). The matching private key is
 * DELIBERATELY not checked in anywhere -- it was used once, off-repo, to
 * generate this constant, then discarded. No real skills are signed or
 * registered against this key in this PR; a real signing/key-management
 * workflow (rotation, per-environment keys, etc.) is a later concern.
 */
export const SKILL_SDK_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATUy40BemGieFbihMkcwiN0c9hXEc0cSF8miFWDiVW4w=
-----END PUBLIC KEY-----
`;
