#!/usr/bin/env node

import { Command } from 'commander';
import loadAddDelegateCommand from './commands/addDelegate';
import loadInitCommand from './commands/init';
import loadSyncCommand from './commands/sync';
const packageJson = require('../package.json');

const program = new Command();

program.name('safecd').description('Reconcile git repository with safes').version(packageJson.version);

loadSyncCommand(program);
loadInitCommand(program);
loadAddDelegateCommand(program);

program.parse();
