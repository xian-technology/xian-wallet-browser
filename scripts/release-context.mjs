#!/usr/bin/env node

import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const SEMVER_PATTERN =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:alpha|beta|rc)\\.(?:0|[1-9]\\d*))?";
const SEMVER_RE = new RegExp(`^${SEMVER_PATTERN}$`);
const TAG_RE = new RegExp(`^v(${SEMVER_PATTERN})$`);
const SHA_RE = /^[0-9a-f]{40}$/;

const POLICIES = {
  "xian-js": {
    component: "xian-contracting",
    repository: "xian-technology/xian-contracting",
    componentPackages: {
      "@xian-tech/compiler": "packages/xian-compiler-core/npm/package.json",
    },
    selfPackages: {
      "xian-js": "package.json",
      "@xian-tech/types": "packages/types/package.json",
      "@xian-tech/client": "packages/client/package.json",
      "@xian-tech/provider": "packages/provider/package.json",
      "@xian-tech/web-kit": "packages/web-kit/package.json",
    },
    internalDependencies: [
      ["packages/client/package.json", "dependencies", "@xian-tech/types"],
      ["packages/provider/package.json", "dependencies", "@xian-tech/types"],
      ["packages/web-kit/package.json", "dependencies", "@xian-tech/provider"],
    ],
    publishedPackages: [
      "@xian-tech/types",
      "@xian-tech/client",
      "@xian-tech/provider",
      "@xian-tech/web-kit",
    ],
  },
  "xian-wallet-browser": {
    components: {
      "xian-js": {
        repository: "xian-technology/xian-js",
        packages: {
          "@xian-tech/client": "packages/client/package.json",
          "@xian-tech/provider": "packages/provider/package.json",
        },
      },
      "xian-contracting": {
        repository: "xian-technology/xian-contracting",
        packages: {
          "@xian-tech/compiler": "packages/xian-compiler-core/npm/package.json",
        },
      },
    },
    selfPackages: {
      "xian-wallet-browser": "package.json",
      "@xian-tech/wallet-core": "packages/wallet-core/package.json",
      "xian-wallet-extension": "apps/wallet-extension/package.json",
    },
    internalDependencies: [
      [
        "apps/wallet-extension/package.json",
        "dependencies",
        "@xian-tech/wallet-core",
      ],
    ],
    publishedPackages: ["@xian-tech/wallet-core"],
    chromeManifest: "apps/wallet-extension/public/manifest.json",
  },
};

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys must be exactly ${wanted.join(", ")}; got ${actual.join(", ")}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(cwd, ...args) {
  return run("git", args, cwd);
}

export function policyForRoot(root) {
  const name = readJson(join(root, "package.json")).name;
  const policy = POLICIES[name];
  if (!policy) {
    fail(`unsupported release repository: ${name}`);
  }
  return policy;
}

export function loadManifest(root) {
  return readJson(join(root, "release-manifest.json"));
}

export function validateManifest(manifest, policy) {
  assertExactKeys(manifest, ["schema_version", "components"], "release manifest");
  if (manifest.schema_version !== 1) {
    fail("release manifest schema_version must be 1");
  }
  const expectedComponentNames = Object.keys(policy.components);
  assertExactKeys(manifest.components, expectedComponentNames, "release manifest components");

  for (const componentName of expectedComponentNames) {
    const componentPolicy = policy.components[componentName];
    const component = manifest.components[componentName];
    assertExactKeys(component, ["repository", "ref", "packages"], componentName);
    if (component.repository !== componentPolicy.repository) {
      fail(
        `${componentName} repository must be ${componentPolicy.repository}; got ${component.repository}`,
      );
    }
    if (!SHA_RE.test(component.ref)) {
      fail(`${componentName} ref must be a lowercase 40-character commit SHA`);
    }

    const expectedPackageNames = Object.keys(componentPolicy.packages);
    assertExactKeys(component.packages, expectedPackageNames, `${componentName} packages`);
    for (const name of expectedPackageNames) {
      const packageSpec = component.packages[name];
      assertExactKeys(packageSpec, ["path", "version"], `${componentName} package ${name}`);
      const expectedPath = componentPolicy.packages[name];
      if (packageSpec.path !== expectedPath) {
        fail(`${name} path must be ${expectedPath}; got ${packageSpec.path}`);
      }
      if (!SEMVER_RE.test(packageSpec.version)) {
        fail(`${name} version is not an accepted release version: ${packageSpec.version}`);
      }
    }
  }
  return manifest.components;
}

export function releaseVersionFromTag(tag) {
  const match = TAG_RE.exec(tag);
  if (!match) {
    fail(`release tag must match vX.Y.Z or vX.Y.Z-(alpha|beta|rc).N; got ${tag}`);
  }
  return match[1];
}

export function chromeExtensionVersion(version) {
  const match = new RegExp(`^(${SEMVER_PATTERN})$`).exec(version);
  if (!match) {
    fail(`unsupported Chrome extension version: ${version}`);
  }
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(version);
  if (!parsed) {
    fail(`unsupported Chrome extension version: ${version}`);
  }
  const [, major, minor, patch, channel, number] = parsed;
  const offsets = { alpha: 10000, beta: 20000, rc: 30000 };
  const build = channel ? offsets[channel] + Number(number) : 65535;
  if (build > 65535) {
    fail(`Chrome extension build component is too large for ${version}`);
  }
  return `${major}.${minor}.${patch}.${build}`;
}

export function verifySelfVersions(root, policy, version) {
  const lock = readJson(join(root, "package-lock.json"));
  for (const [name, relativePath] of Object.entries(policy.selfPackages)) {
    const packageJson = readJson(join(root, relativePath));
    if (packageJson.name !== name) {
      fail(`${relativePath} has name ${packageJson.name}; expected ${name}`);
    }
    if (packageJson.version !== version) {
      fail(`${relativePath} has version ${packageJson.version}; expected ${version}`);
    }
    const lockPath = relativePath === "package.json" ? "" : dirname(relativePath);
    const lockPackage = lock.packages?.[lockPath];
    if (!lockPackage) {
      fail(`package-lock.json is missing packages[${JSON.stringify(lockPath)}]`);
    }
    if (lockPackage.name !== name || lockPackage.version !== version) {
      fail(
        `package-lock.json ${lockPath || "root"} is ${lockPackage.name}@${lockPackage.version}; expected ${name}@${version}`,
      );
    }
  }

  for (const [relativePath, section, dependency] of policy.internalDependencies) {
    const packageJson = readJson(join(root, relativePath));
    const actual = packageJson[section]?.[dependency];
    if (actual !== version) {
      fail(`${relativePath} ${section}.${dependency} is ${actual}; expected ${version}`);
    }
  }

  if (policy.chromeManifest) {
    const manifest = readJson(join(root, policy.chromeManifest));
    const expectedChromeVersion = chromeExtensionVersion(version);
    if (manifest.version_name !== version) {
      fail(`${policy.chromeManifest} version_name is ${manifest.version_name}; expected ${version}`);
    }
    if (manifest.version !== expectedChromeVersion) {
      fail(
        `${policy.chromeManifest} version is ${manifest.version}; expected ${expectedChromeVersion}`,
      );
    }
  }
}

export function verifyComponentLock(root, policy, components, checkoutRoots = undefined) {
  const roots = checkoutRoots ??
    Object.fromEntries(Object.keys(policy.components).map((name) => [name, resolve(root, "..", name)]));
  const lockOwners = [root, ...Object.values(roots)];
  const locks = lockOwners.flatMap((lockRoot) => {
    try {
      return [[lockRoot, readJson(join(lockRoot, "package-lock.json"))]];
    } catch {
      return [];
    }
  });

  for (const [componentName, component] of Object.entries(components)) {
    for (const [name, packageSpec] of Object.entries(component.packages)) {
      const expectedLockPath = `../${componentName}/${dirname(packageSpec.path)}`;
      const match = locks.find(([, lock]) => lock.packages?.[expectedLockPath]);
      if (!match) {
        fail(`no release lockfile contains pinned component path ${expectedLockPath}`);
      }
      const [lockRoot, lock] = match;
      const locked = lock.packages[expectedLockPath];
      if (locked.name !== name || locked.version !== packageSpec.version) {
        fail(
          `${join(lockRoot, "package-lock.json")} ${expectedLockPath} is ${locked.name}@${locked.version}; expected ${name}@${packageSpec.version}`,
        );
      }
    }
  }
}

function assertCleanCheckout(checkout, label) {
  const status = git(checkout, "status", "--porcelain", "--untracked-files=all");
  if (status) {
    fail(`${label} checkout is not clean:\n${status}`);
  }
}

export function resolveReleaseContext(root, { tag, triggerSha, refType }) {
  if (refType !== "tag") {
    fail(`release workflow must be triggered by a tag; got ref type ${refType}`);
  }
  const policy = policyForRoot(root);
  const manifest = loadManifest(root);
  const components = validateManifest(manifest, policy);
  const version = releaseVersionFromTag(tag);
  verifySelfVersions(root, policy, version);

  const head = git(root, "rev-parse", "HEAD");
  const tagCommit = git(root, "rev-parse", `refs/tags/${tag}^{commit}`);
  const triggerCommit = git(root, "rev-parse", `${triggerSha}^{commit}`);
  if (head !== tagCommit || head !== triggerCommit) {
    fail(`release source mismatch: HEAD=${head}, tag=${tagCommit}, trigger=${triggerCommit}`);
  }
  assertCleanCheckout(root, "release source");

  return { components, policy, sourceSha: head, version };
}

export function verifyPinnedCheckout(root, { expectedSourceSha, tag }) {
  const policy = policyForRoot(root);
  const components = validateManifest(loadManifest(root), policy);
  const version = releaseVersionFromTag(tag);
  const sourceHead = git(root, "rev-parse", "HEAD");
  if (sourceHead !== expectedSourceSha || !SHA_RE.test(expectedSourceSha)) {
    fail(`release source HEAD is ${sourceHead}; expected ${expectedSourceSha}`);
  }
  assertCleanCheckout(root, "release source");
  verifySelfVersions(root, policy, version);
  const checkoutRoots = Object.fromEntries(
    Object.keys(policy.components).map((name) => [name, resolve(root, "..", name)]),
  );
  for (const [componentName, component] of Object.entries(components)) {
    const componentCheckout = checkoutRoots[componentName];
    const componentHead = git(componentCheckout, "rev-parse", "HEAD");
    if (componentHead !== component.ref) {
      fail(`${componentName} HEAD is ${componentHead}; expected ${component.ref}`);
    }
    assertCleanCheckout(componentCheckout, componentName);
    for (const [name, packageSpec] of Object.entries(component.packages)) {
      const packageJson = readJson(join(componentCheckout, packageSpec.path));
      if (packageJson.name !== name || packageJson.version !== packageSpec.version) {
        fail(
          `${componentName}/${packageSpec.path} is ${packageJson.name}@${packageJson.version}; expected ${name}@${packageSpec.version}`,
        );
      }
    }
  }
  verifyComponentLock(root, policy, components, checkoutRoots);
}

function npmPackageMetadata(archive) {
  return JSON.parse(run("tar", ["-xOf", archive, "package/package.json"], process.cwd()));
}

export function verifyArtifacts(root, artifactDirectory, tag) {
  const policy = policyForRoot(root);
  const version = releaseVersionFromTag(tag);
  const files = readdirSync(artifactDirectory).sort();
  const tarballs = files.filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== policy.publishedPackages.length) {
    fail(
      `expected ${policy.publishedPackages.length} npm tarballs; found ${tarballs.length}: ${tarballs.join(", ")}`,
    );
  }
  const remaining = new Set(policy.publishedPackages);
  for (const file of tarballs) {
    const metadata = npmPackageMetadata(resolve(artifactDirectory, file));
    if (!remaining.delete(metadata.name)) {
      fail(`unexpected or duplicate npm package in ${file}: ${metadata.name}`);
    }
    if (metadata.version !== version) {
      fail(`${file} contains ${metadata.name}@${metadata.version}; expected ${version}`);
    }
  }
  if (remaining.size) {
    fail(`missing npm artifacts: ${[...remaining].join(", ")}`);
  }

  if (policy.chromeManifest) {
    const expectedZip = `xian-wallet-extension-${version}.zip`;
    const zipFiles = files.filter((file) => file.endsWith(".zip"));
    if (zipFiles.length !== 1 || zipFiles[0] !== expectedZip) {
      fail(`expected only ${expectedZip}; found ${zipFiles.join(", ") || "no zip artifacts"}`);
    }
    const extensionManifest = JSON.parse(
      run("unzip", ["-p", resolve(artifactDirectory, expectedZip), "manifest.json"], root),
    );
    if (
      extensionManifest.version_name !== version ||
      extensionManifest.version !== chromeExtensionVersion(version)
    ) {
      fail(`${expectedZip} contains extension metadata for a different version`);
    }
  } else if (files.some((file) => file.endsWith(".zip"))) {
    fail("unexpected zip artifact in npm-only release");
  }
}

function writeGithubOutputs(path, context) {
  const componentOutputs = Object.entries(context.components).flatMap(([name, component]) => {
    const prefix = name.replaceAll("-", "_");
    return [`${prefix}_repository=${component.repository}`, `${prefix}_ref=${component.ref}`];
  });
  appendFileSync(
    path,
    [
      `source_sha=${context.sourceSha}`,
      `version=${context.version}`,
      ...componentOutputs,
      "",
    ].join("\n"),
  );
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    fail(`missing required environment variable: ${name}`);
  }
  return value;
}

function main() {
  const command = process.argv[2];
  const root = process.cwd();
  if (command === "validate-manifest") {
    const policy = policyForRoot(root);
    const components = validateManifest(loadManifest(root), policy);
    verifyComponentLock(root, policy, components);
    return;
  }
  if (command === "resolve") {
    const context = resolveReleaseContext(root, {
      tag: requiredEnv("RELEASE_TAG"),
      triggerSha: requiredEnv("TRIGGER_SHA"),
      refType: requiredEnv("GITHUB_REF_TYPE"),
    });
    writeGithubOutputs(requiredEnv("GITHUB_OUTPUT"), context);
    return;
  }
  if (command === "verify-component") {
    verifyPinnedCheckout(root, {
      expectedSourceSha: requiredEnv("EXPECTED_SOURCE_SHA"),
      tag: requiredEnv("RELEASE_TAG"),
    });
    return;
  }
  if (command === "verify-artifacts") {
    verifyArtifacts(root, requiredEnv("ARTIFACT_DIRECTORY"), requiredEnv("RELEASE_TAG"));
    return;
  }
  fail(`unknown command: ${command ?? "(missing)"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
