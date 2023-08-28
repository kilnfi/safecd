import { Command } from 'commander';
import { writeFileSync } from 'fs';
import { promisify } from 'util';
import YAML from 'yaml';
const exec = promisify(require('child_process').exec);

export default function loadCommand(command: Command): void {
	command
		.command('init')
		.requiredOption('--network <char>', 'network to use for the repository')
		.requiredOption('--safe <char>', 'initial safe address')
		.action(async options => {
			console.log('initializing current directory');
			await exec('forge init');
			await exec('rm -rf src test script');
			await exec('git clone https://github.com/kilnfi/safecd-templates.git ./template');
			await exec('cp -r ./template/script .');
			await exec('cp -r ./template/.github_templates .github');
			await exec('cp ./template/.gitignore .');
			await exec('rm -rf template');
			await exec('mkdir safes');
			writeFileSync(
				'./safecd.yaml',
				YAML.stringify({
					network: options.network
				})
			);
			writeFileSync(
				`./safes/${options.safe}.yaml`,
				YAML.stringify({
					address: options.safe,
					name: options.safe,
					type: 'safe'
				})
			);
		});
}
