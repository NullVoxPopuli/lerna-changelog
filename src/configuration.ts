const fs = require("fs");
const path = require("path");
const execa = require("execa");
const hostedGitInfo = require("hosted-git-info");

import ConfigurationError from "./configuration-error";
import { getRootPath } from "./git";

export interface Configuration {
  repo: string;
  rootPath: string;
  labels: { [key: string]: string };
  ignoreCommitters: string[];
  cacheDir?: string;
  nextVersion: string | undefined;
  nextVersionFromMetadata?: boolean;
  wildcardLabel?: string;
  packages: [{ name: string; path: string }] | [];
}

export interface ConfigLoaderOptions {
  repo?: string;
  nextVersionFromMetadata?: boolean;
}

export function load(options: ConfigLoaderOptions = {}): Configuration {
  let rootPath = getRootPath();
  return fromPath(rootPath, options);
}

function getPackages(rootPath: string): [{ name: string; path: string }] | [] {
  let packages = [];

  if (fs.existsSync(path.join(rootPath, "package-lock.json"))) {
    const result = execa.sync("npm", ["query", ".workspace"], { cwd: rootPath });
    const workspaceQuery = JSON.parse(result.stdout);

    packages = workspaceQuery.map((item: any) => ({ name: item.name, path: item.path }));
  } else if (fs.existsSync(path.join(rootPath, "pnpm-lock.yaml"))) {
    const result = execa.sync(`pnpm`, ["m", "ls", "--json", "--depth=-1"], { cwd: rootPath });
    const workspaceJson = JSON.parse(result.stdout);

    packages = workspaceJson
      .filter((item: any) => item.name && item.path)
      .map((item: any) => ({ name: item.name, path: item.path }));
  } else if (fs.existsSync(path.join(rootPath, "yarn.lock"))) {
    const result = execa.sync(`yarn`, ["--silent", "workspaces", "info", "--json"], { cwd: rootPath });
    const workspaceMap = JSON.parse(result.stdout);

    packages = Object.keys(workspaceMap).map(key => ({
      name: key,
      path: path.resolve(rootPath, workspaceMap[key].location),
    }));
  }

  return packages;
}

export function fromPath(rootPath: string, options: ConfigLoaderOptions = {}): Configuration {
  // Step 1: load partial config from `package.json` or `lerna.json`
  let config = fromPackageConfig(rootPath) || fromLernaConfig(rootPath) || {};

  if (options.repo) {
    config.repo = options.repo;
  }

  // Step 2: fill partial config with defaults
  let { repo, nextVersion, labels, cacheDir, ignoreCommitters, wildcardLabel } = config;

  const packages = getPackages(rootPath);

  if (!repo) {
    repo = findRepo(rootPath);
    if (!repo) {
      throw new ConfigurationError('Could not infer "repo" from the "package.json" file.');
    }
  }

  if (options.nextVersionFromMetadata || config.nextVersionFromMetadata) {
    nextVersion = findNextVersion(rootPath);

    if (!nextVersion) {
      throw new ConfigurationError('Could not infer "nextVersion" from the "package.json" file.');
    }
  }

  if (!labels) {
    labels = {
      breaking: ":boom: Breaking Change",
      enhancement: ":rocket: Enhancement",
      bug: ":bug: Bug Fix",
      documentation: ":memo: Documentation",
      internal: ":house: Internal",
    };
  }

  if (wildcardLabel && !labels[wildcardLabel]) {
    labels[wildcardLabel] = "️:present: Additional updates";
  }

  if (!ignoreCommitters) {
    ignoreCommitters = [
      "dependabot-bot",
      "dependabot[bot]",
      "dependabot-preview[bot]",
      "greenkeeperio-bot",
      "greenkeeper[bot]",
      "renovate-bot",
      "renovate[bot]",
    ];
  }

  return {
    repo,
    nextVersion,
    rootPath,
    labels,
    ignoreCommitters,
    cacheDir,
    wildcardLabel,
    packages,
  };
}

function fromLernaConfig(rootPath: string): Partial<Configuration> | undefined {
  const lernaPath = path.join(rootPath, "lerna.json");
  if (fs.existsSync(lernaPath)) {
    return JSON.parse(fs.readFileSync(lernaPath)).changelog;
  }
}

function fromPackageConfig(rootPath: string): Partial<Configuration> | undefined {
  const pkgPath = path.join(rootPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    return JSON.parse(fs.readFileSync(pkgPath)).changelog;
  }
}

function findRepo(rootPath: string): string | undefined {
  const pkgPath = path.join(rootPath, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath));
  if (!pkg.repository) {
    return;
  }

  return findRepoFromPkg(pkg);
}

function findNextVersion(rootPath: string): string | undefined {
  const pkgPath = path.join(rootPath, "package.json");
  const lernaPath = path.join(rootPath, "lerna.json");

  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath)) : {};
  const lerna = fs.existsSync(lernaPath) ? JSON.parse(fs.readFileSync(lernaPath)) : {};

  return pkg.version ? `v${pkg.version}` : lerna.version ? `v${lerna.version}` : undefined;
}

export function findRepoFromPkg(pkg: any): string | undefined {
  const url = pkg.repository.url || pkg.repository;
  const info = hostedGitInfo.fromUrl(url);
  if (info && info.type === "github") {
    return `${info.user}/${info.project}`;
  }
}
