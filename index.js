#!/usr/bin/env node

import { spawn } from 'child_process';
import { mkdir, readFile } from 'fs/promises';
import os from 'os';
import { join, parse } from 'path';

const availableCommands = [ 'test', 'run', 'list', 'help' ];

(async () => {
  const tokens = process.argv.slice(2).map((value) => {
    return { value, flags: value.startsWith('-'), consumed: false };
  });
  let command = tokens.find(t => !t.flags );
  if (!command) {
    printHelp();
    process.exit(0);
  }
  const availableConfigs = await loadConfigurations();
  let selected;
  if (!availableCommands.includes(command.value)) {
    command.consumed = true;
    selected = availableConfigs[command.value];
    if (!selected) {
      listConfigurations(availableConfigs);
      log(`error: configuration "${command.value}" not found\n`);
      process.exit(1);
    }
    command = tokens.find(t => !t.flags && !t.consumed);
    if (!command) {
      printHelp();
      log(`error: expected command arument\n`);
      process.exit(1);
    }
  }
  command.consumed = true;
  let file;
  if ([ 'run', 'test' ].includes(command.value)) {
    file = tokens.find(t => !t.flags && !t.consumed);
    if (!file) {
      log(`error: expected filename\n`);
      process.exit(1);
    }
    file.consumed = true;
  }
  const extras = tokens.filter(t => !t.consumed).map(t => t.value);
  const configs = (selected) ? [ selected ] : Object.values(availableConfigs);
  let failures = 0;
  for (const config of configs) {
    switch (command.value) {
    case 'test':
      failures += await runTest(file, config, extras);
      break;
    case 'run':
      failures += await runProgram(file, config, extras);
      break;
    case 'list':
      listConfigurations(availableConfigs);
      return;
    case 'help':
      printHelp();
      return;
    }
  }
  process.exit(failures ? 1 : 0);
})();

async function runTest(file, config, extras) {
  try {
    const { zig, docker } = config;
    const info = parse(file.value);
    const dir = join(os.tmpdir(), 'zdq', zig.arch, zig.platform);
    const name = `${info.name}.test`;
    const path = join(dir, name);
    await makeDir(dir);
    await run('zig', [
      'test',
      `--test-no-exec`,
      `-target`,
      `${zig.arch}-${zig.platform}`,
      `-femit-bin=${path}`,
      file.value,
      ...extras
    ]);
    const dirVM = `/home/zdq/${zig.arch}/${zig.platform}`;
    print(`Running test in ${docker.platform}/${docker.arch}:\n`);
    await run('docker', [
      'run',
      `--platform`,
      `${docker.platform}/${docker.arch}`,
      `-v`,
      `${dir}:${dirVM}`,
      `-w`,
      dirVM,
      `--rm`,
      `-t`,
      `-q`,
      docker.image,
      `./${name}`,
    ]);
    return 0;
  } catch (err) {
    return 1;
  }
}

async function runProgram(file, config, extras) {
  try {
    const { zig, docker } = config;
    const info = parse(file.value);
    const dir = join(os.tmpdir(), 'zdq', zig.arch, zig.platform);
    const name = `${info.name}`;
    const path = join(dir, name);
    await makeDir(dir);
    await run('zig', [
      'build-exe',
      `-target`,
      `${zig.arch}-${zig.platform}`,
      `-femit-bin=${path}`,
      file.value,
      ...extras
    ]);
    const dirVM = `/home/zdq/${zig.arch}/${zig.platform}`;
    print(`Running executable in ${docker.platform}/${docker.arch}:\n`);
    await run('docker', [
      'run',
      `--platform`,
      `${docker.platform}/${docker.arch}`,
      `-v`,
      `${dir}:${dirVM}`,
      `-w`,
      dirVM,
      `--rm`,
      `-t`,
      docker.image,
      `./${name}`,
    ]);
    return 0;
  } catch (err) {
    return 1;
  }
}

function listConfigurations(availableConfigs) {
  for (const [ name, { zig, docker } ] of Object.entries(availableConfigs)) {
    print(`${name}:\n`)
    print(`    Zig compile target: ${zig.arch}-${zig.platform}\n`);
    print(`    Docker environment: ${docker.platform}/${docker.arch}\n`);
    print(`                 image: ${docker.image}\n`)
    print(`\n`);
  }
}

function printHelp() {
  print(`Usage: zdq [config] <command>\n`);
  print(`\n`);
  print(`Commands:\n`);
  print(`  test             Perform unit testing\n`);
  print(`  run              Create executable and run immediately\n`);
  print(`\n`);
  print(`  list             List available configurations\n`);
  print(`  help             Print this help and exit\n`);
  print(`\n`);
}

function getDefaultConfig() {
  return {
    zig: {
      arch: (os.arch() === 'x64') ? 'aarch64' : 'x86_64',
      platform: 'linux',
    },
    docker: {
      arch: (os.arch() === 'x64') ? 'arm64' : 'amd64',
      platform: 'linux',
      image: 'ubuntu',
    }
  };
}

async function loadConfigurations() {
  try {
    const path = join(os.homedir(), '.zdq.json');
    const json = await readFile(path, 'utf8');
    return JSON.parse(json);
  } catch (err) {
    const def = getDefaultConfig();
    return { [def.docker.arch]: def };
  }
}

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
  const options = {
    stdio: [ 'inherit', 'inherit', 'inherit' ],
  };
  const child = spawn(cmd, args, options);
  child.on('close', (code) => {
    if (!code) {
        resolve();
    } else {
        const err = new Error(`Exit code ${code}`);
        err.code = code;
        reject(err);
      }
    });
  });
};

async function makeDir(path) {
  try {
    await mkdir(path, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }
}

function print(text) {
  process.stdout.write(text);
}

function log(text) {
  process.stderr.write(text);
}
