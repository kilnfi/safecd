import { Command, Option } from 'commander';
import { promisify } from 'util';
import { handleReminders } from '../notifications';
import { checkRequirements } from '../requirements';
import { State } from '../state';
const exec = promisify(require('child_process').exec);

const usersOption = new Option(
	'--users <char>',
	'List of users, slack ids and timezones. EOA_NAME:SLACK_ID:TIMEZONE;EOA_NAME:SLACK_ID:TIMEZONE'
).env('USERS');
usersOption.mandatory = true;

export default function loadCommand(command: Command): void {
	command
		.command('reminders')
		.description('sends reminders to owners of safes that have pending proposals')
		.addOption(usersOption)
		.addOption(new Option('--dry-run', 'do not write to disk').default(false).env('DRY_RUN'))
		.action(async options => {
			await checkRequirements();

			console.log();
			console.log('  ================================================  ');
			console.log();
			console.log('  ███████╗ █████╗ ███████╗███████╗ ██████╗██████╗');
			console.log('  ██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██╔══██╗');
			console.log('  ███████╗███████║█████╗  █████╗  ██║     ██║  ██║');
			console.log('  ╚════██║██╔══██║██╔══╝  ██╔══╝  ██║     ██║  ██║');
			console.log('  ███████║██║  ██║██║     ███████╗╚██████╗██████╔╝');
			console.log('  ╚══════╝╚═╝  ╚═╝╚═╝     ╚══════╝ ╚═════╝╚═════╝');
			console.log();
			console.log('  ================================================  ');
			console.log();

			const pks = process.env.PRIVATE_KEYS?.split(',') || [];
			if (process.env.CI === 'true') {
				console.log(`  ci=true`);
			}
			console.log(`  users=${options.users}`);
			console.log(`  dryRun=${options.dryRun}`);
			console.log();
			console.log('  ================================================  ');
			console.log();
			const shouldWrite = !options.dryRun;
			const state = new State();
			await state.load();
			await handleReminders(options.users, state, shouldWrite);
		});
}
