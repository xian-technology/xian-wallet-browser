import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  chromeExtensionVersion,
  loadManifest,
  policyForRoot,
  releaseVersionFromTag,
  validateManifest,
  verifyComponentLock,
  verifySelfVersions,
} from "./release-context.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = policyForRoot(root);

test("checked-in release manifest and component lock versions agree", () => {
  const manifest = loadManifest(root);
  const components = validateManifest(manifest, policy);
  verifyComponentLock(root, policy, components);
});

test("manifest rejects a floating component ref", () => {
  const manifest = structuredClone(loadManifest(root));
  const [component] = Object.keys(policy.components);
  manifest.components[component].ref = "main";
  assert.throws(() => validateManifest(manifest, policy), /40-character commit SHA/);
});

test("manifest rejects missing component package authority", () => {
  const manifest = structuredClone(loadManifest(root));
  const [component] = Object.keys(policy.components);
  const [name] = Object.keys(manifest.components[component].packages);
  delete manifest.components[component].packages[name];
  assert.throws(() => validateManifest(manifest, policy), /packages.*keys must be exactly/);
});

test("release tags use the accepted strict version grammar", () => {
  assert.equal(releaseVersionFromTag("v1.2.3"), "1.2.3");
  assert.equal(releaseVersionFromTag("v1.2.3-beta.4"), "1.2.3-beta.4");
  assert.throws(() => releaseVersionFromTag("v1.2"), /release tag must match/);
  assert.throws(() => releaseVersionFromTag("v1.2.3-preview.1"), /release tag must match/);
});

test("self package and lock versions agree", () => {
  const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  verifySelfVersions(root, policy, packageVersion);
});

test("Chrome extension release versions remain deterministic", () => {
  assert.equal(chromeExtensionVersion("1.2.3"), "1.2.3.65535");
  assert.equal(chromeExtensionVersion("1.2.3-beta.4"), "1.2.3.20004");
});
