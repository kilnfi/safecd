import { utils } from 'ethers';
import { readdirSync } from 'fs';
import { EOA, EOASchema, load, PopulatedSafe, PopulatedSafeSchema, SafeCDKit } from '../types';

export async function generateRootReadme(scdk: SafeCDKit): Promise<void> {
	let content = `# ${scdk.config.title}

\`\`\`mermaid
%%{init: {'theme': 'dark', "flowchart" : { "curve" : "linear" } } }%%
${generateSafesDiagram(scdk)}
\`\`\`	

${generateSafesDetailsDiagram(scdk)}
`;

	scdk.fs.write('./README.md', content);
}

function generateSafesDetailsDiagram(scdk: SafeCDKit): string {
	let content = '';
	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		content += `
---

### ${safe.name}

${safe.description ? safe.description : ''}

\`\`\`mermaid
%%{init: {'theme': 'dark', "flowchart" : { "curve" : "linear" } } }%%
flowchart LR
subgraph ${safe.name}
direction LR
${generateSafeDiagram(scdk, safe, {})}
end
\`\`\`

`;
	}
	return content;
}

function generateSafesDiagram(scdk: SafeCDKit): string {
	let content = 'flowchart LR\nsubgraph Overview\ndirection LR\n';
	const done = {};
	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		content += generateSafeDiagram(scdk, safe, done);
	}
	content += 'end\n';
	return content;
}

function generateSafeDiagram(scdk: SafeCDKit, safe: PopulatedSafe, done: { [key: string]: boolean }): string {
	let content = '';
	if (done[safe.address]) {
		return content;
	}
	done[safe.address] = true;

	for (const owner of safe.owners) {
		const ownerSafe = getSafe(owner, scdk);
		if (ownerSafe !== null) {
			content += `${owner}{{${getNames(scdk, owner).join(', ')}<br/>type=safe,threshold=${
				ownerSafe.threshold
			}<br/>${owner}}} -->|owner| ${safe.address}{{${safe.name}<br/>type=safe,threshold=${safe.threshold}<br/>${
				safe.address
			}}}\n`;
		} else {
			content += `${owner}(${getNames(scdk, owner).join(', ')}<br/>type=eoa<br/>${owner}) -->|owner| ${
				safe.address
			}{{${safe.name}<br/>type=safe,threshold=${safe.threshold}<br/>${safe.address}}}\n`;
		}
	}

	for (const delegate of safe.delegates) {
		const delegateAddress = delegate.delegate;
		const delegateSafe = getSafe(delegateAddress, scdk);
		if (delegateSafe !== null) {
			content += `${delegateAddress}{{${getNames(scdk, delegateAddress).join(', ')}<br/>type=safe,threshold=${
				delegateSafe.threshold
			},label=${delegate.label}<br/>${delegateAddress}}} -->|delegate| ${safe.address}{{${
				safe.name
			}<br/>type=safe,threshold=${safe.threshold}<br/>${safe.address}}}\n`;
		} else {
			content += `${delegateAddress}(${getNames(scdk, delegateAddress).join(', ')}<br/>type=eoa,label=${
				delegate.label
			}<br/>${delegateAddress}) -->|delegate| ${safe.address}{{${safe.name}<br/>type=safe,threshold=${
				safe.threshold
			}<br/>${safe.address}}}\n`;
		}
	}

	return content;
}

function getNames(scdk: SafeCDKit, address: string): string[] {
	let names = [];
	const eoas = readdirSync('./eoas');
	for (const eoa of eoas) {
		const loadedEOA: EOA = load<EOA>(scdk.fs, EOASchema, `./eoas/${eoa}`);
		if (utils.getAddress(loadedEOA.address) === utils.getAddress(address)) {
			names.push(loadedEOA.name);
		}
	}

	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		if (utils.getAddress(safe.address) === utils.getAddress(address)) {
			names.push(safe.name);
		}
	}

	return names;
}

function getSafe(address: string, scdk: SafeCDKit): PopulatedSafe | null {
	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		if (utils.getAddress(safe.address) === utils.getAddress(address)) {
			return safe;
		}
	}
	return null;
}
