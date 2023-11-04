import { utils } from 'ethers';
import { existsSync, readFileSync } from 'fs';
import YAML from 'yaml';
import { EOA, PopulatedSafe, Proposal, SafeCDKit, Transaction } from '../types';

const explorerByNetwork: { [key: string]: string } = {
	mainnet: 'https://etherscan.io',
	goerli: 'https://goerli.etherscan.io'
};

const uiByNetwork: { [key: string]: string } = {
	mainnet: 'https://app.safe.global/home?safe=eth:',
	goerli: 'https://app.safe.global/home?safe=gor'
};

const safeTxLinkByNetwork: { [key: string]: string } = {
	mainnet: 'https://app.safe.global/transactions/tx?safe=eth:',
	goerli: 'https://app.safe.global/transactions/tx?safe=gor:'
};

export async function generateRootReadme(scdk: SafeCDKit): Promise<string | null> {
	let content = `# ${scdk.state.config.title}

\`\`\`mermaid
%%{init: {'theme': 'dark', "flowchart" : { "curve" : "basis" } } }%%
${generateSafesDiagram(scdk)}
\`\`\`

${
	scdk.state.config.addressBook
		? `## Address Book

${generateAddressBook(scdk)}
`
		: ''
}

${generateSafesDetailsDiagram(scdk)}
`;

	if (!existsSync('./README.md') || readFileSync('./README.md', 'utf8') !== content) {
		return content;
	}
	return null;
}

function generateAddressBook(scdk: SafeCDKit): string {
	return `
<table>

<tr>
<td>Name</td>
<td>Address</td>
<tr>

${scdk.state.config.addressBook
	?.map(
		entry => `
<tr>
<td><code>${entry.name}</code></td>
<td><code><a href="${getAddressExplorerLink(scdk, entry.address)}" target="_blank">${entry.address}</a></code></td>
</tr>
`
	)
	.join('\n')}

</table>
`;
}

function generateSafesDetailsDiagram(scdk: SafeCDKit): string {
	let content = '';
	for (let safeIdx = 0; safeIdx < scdk.state.safes.length; ++safeIdx) {
		const safe: PopulatedSafe = scdk.state.safes[safeIdx].entity as PopulatedSafe;
		const safeTransactions: Transaction[] = getAllSafeTransactions(scdk, safe);
		const [diagram] = generateSafeDiagram(scdk, safe, 0, {});
		content += `
---

## [${safe.name} (\`${safe.address}\`)](${uiByNetwork[scdk.network]}${safe.address})

${safe.description ? safe.description : ''}

\`\`\`mermaid
%%{init: {'theme': 'dark', "flowchart" : { "curve" : "basis" } } }%%
flowchart LR
subgraph "Safe ${safe.name}"
direction LR
${diagram}
end
\`\`\`


${
	safeTransactions.filter(tx => !tx.isExecuted).length === 0
		? ''
		: formatPendingTransactionsTable(
				scdk,
				safe,
				safeTransactions.filter(tx => !tx.isExecuted)
		  )
}

### Owner Leaderboard

<table>

<tr>
<td>Owner</td>
<td>Score</td>
<td>Signatures</td>
<td>Executions</td>
</tr>

${formatOwnerLeaderboard(scdk, safe)}

</table


### Transaction History

<details>
<summary>Click to expand</summary>

<table>

<tr>
<td>Nonce</td>
<td>Title</td>
<td>Description</td>
<td>Payload</td>
<td>Safe Tx</td>
<td>Signers</td>
<td>Executor</td>
<td>Tx</td>
<td>Proposal</td>
</tr>

${formatSafeTransactions(
	scdk,
	safe,
	safeTransactions.filter(tx => tx.isExecuted)
)}

</table>

</details>

`;
	}
	return content;
}

function formatPendingTransactionsTable(scdk: SafeCDKit, safe: PopulatedSafe, txs: Transaction[]): string {
	return `
### Pending Transactions

<table>

<tr>
<td>Nonce</td>
<td>Title</td>
<td>Description</td>
<td>Payload</td>
<td>Safe Tx</td>
<td>Confirmations</td>
<td>Signers</td>
<td>Proposal</td>
</tr>

${formatSafeTransactions(scdk, safe, txs)}

</table>

`;
}

function getTxTitle(tx: Transaction): string {
	if (utils.getAddress(tx.safe) === utils.getAddress(tx.to) && tx.data === null) {
		if (tx.value === '0') {
			return 'Transaction rejection';
		}
		return `Ether transfer of ${utils.formatEther(tx.value)} ETH`;
	}
	if (tx.dataDecoded?.method) {
		return `\`\`\`solidity

${tx.dataDecoded.method}(
  ${tx.dataDecoded.parameters?.map((p: any) => `${p.name}: ${p.type}`).join(',\n  ') || ''}
)

\`\`\``;
	}
	return '';
}

function getProposalOfSafeHash(scdk: SafeCDKit, hash: string): [string | null, Proposal | null] {
	return [scdk.state.getProposalPathByHash(hash), scdk.state.getProposalByHash(hash)];
}

function formatOwnerLeaderboard(scdk: SafeCDKit, safe: PopulatedSafe): string {
	let content = '';
	const txs = getAllSafeTransactions(scdk, safe);
	const ownerScores: { [key: string]: number } = {};
	const ownerSignatures: { [key: string]: number } = {};
	const ownerExecutions: { [key: string]: number } = {};
	for (const tx of txs) {
		if (tx.isExecuted) {
			ownerExecutions[(tx.executor as string).toLowerCase()] =
				(ownerExecutions[(tx.executor as string).toLowerCase()] || 0) + 1;
			ownerScores[(tx.executor as string).toLowerCase()] =
				(ownerScores[(tx.executor as string).toLowerCase()] || 0) + 1;
		}
		for (const confirmation of tx.confirmations) {
			ownerSignatures[confirmation.owner.toLowerCase()] =
				(ownerSignatures[confirmation.owner.toLowerCase()] || 0) + 1;
			ownerScores[confirmation.owner.toLowerCase()] = (ownerScores[confirmation.owner.toLowerCase()] || 0) + 1;
		}
	}
	const owners = Object.keys(ownerScores)
		.map(owner => {
			return {
				owner,
				score: ownerScores[owner] || 0,
				signatures: ownerSignatures[owner] || 0,
				executions: ownerExecutions[owner] || 0
			};
		})
		.sort((a, b) => b.score - a.score);

	let idx = 0;
	const medals = ['🥇', '🥈', '🥉'];

	for (const owner of owners) {
		content += `
<tr>
<td>${idx < medals.length ? `${medals[idx]} ` : ' '}${getNameAndType(scdk, owner.owner)}</td>
<td>${owner.score}</td>
<td>${owner.signatures}</td>
<td>${owner.executions}</td>
</tr>
`;
		++idx;
	}

	return content;
}

function formatSafeTransactions(scdk: SafeCDKit, safe: PopulatedSafe, txs: Transaction[]): string {
	let content = '';
	for (const tx of txs) {
		const [proposalPath, proposal] = getProposalOfSafeHash(scdk, tx.safeTxHash);
		content += `
<tr>
<td>${tx.nonce}</td>
<td>

${proposal ? proposal.title : getTxTitle(tx)}

</td>
<td>
${
	proposal
		? `
<details>
<summary></summary>


${proposal.description}


</details>
`
		: ''
}
</td>
<td>
<details>
<summary></summary>


\`\`\`yaml
${YAML.stringify(tx, { lineWidth: 0 })}
\`\`\`


</details>
<td>
<a href=${getSafeTxLink(scdk, tx)}><code>${tx.safeTxHash}</code></a>
${proposal ? resolveChildProposals(scdk, proposal, 1) : ''}
</td>
</td>
${tx.isExecuted ? '' : `<td>${getConfirmationIcons(tx.confirmations.length, safe.threshold)}</td>`}
<td>${resolveConfirmations(scdk, tx)}</td>
${tx.isExecuted ? `<td>${resolveExecutor(scdk, tx)}</td>` : ''}
${tx.isExecuted ? `<td><a target="_blank" href="${getTxExplorerLink(scdk, tx)}">🔗</a></td>` : ''}
<td>${proposal ? `<a target="_blank" href="${proposalPath}">🔗</a>` : ''}</td>
</tr>
`;
	}
	return content;
}

function resolveChildProposals(scdk: SafeCDKit, proposal: Proposal, depth: number): string {
	if (proposal.childOf) {
		const parentSafe = getSafe(proposal.childOf.safe, scdk);
		if (parentSafe) {
			const [, parentProposal] = getProposalOfSafeHash(scdk, proposal.childOf.hash);
			return `<br/>${'&nbsp;&nbsp;'.repeat(depth)}↳ approves <a href=${getParentSafeTxLink(
				scdk,
				proposal.childOf.safe,
				proposal.childOf.hash
			)}><code>${proposal.childOf.hash}</code></a>${
				parentProposal ? resolveChildProposals(scdk, parentProposal, depth + 1) : ''
			}`;
		}
	}
	return '';
}

function getConfirmationIcons(confirmationCount: number, threshold: number): string {
	return '🟩'.repeat(confirmationCount) + '⬜️'.repeat(threshold - confirmationCount);
}

function resolveExecutor(scdk: SafeCDKit, tx: Transaction): string {
	return getNameAndType(scdk, tx.executor as string);
}

function resolveConfirmations(scdk: SafeCDKit, tx: Transaction): string {
	let content = [];
	for (const confirmation of tx.confirmations) {
		content.push(getNameAndType(scdk, confirmation.owner));
	}
	return content.join('<br/>');
}

function getAddressExplorerLink(scdk: SafeCDKit, address: string): string {
	return `${explorerByNetwork[scdk.network]}/address/${address}`;
}

function getTxExplorerLink(scdk: SafeCDKit, tx: Transaction): string {
	return `${explorerByNetwork[scdk.network]}/tx/${tx.transactionHash}`;
}

function getParentSafeTxLink(scdk: SafeCDKit, safe: string, hash: string): string {
	return `${safeTxLinkByNetwork[scdk.network]}${safe}&id=multisig_${safe}_${hash}`;
}

function getSafeTxLink(scdk: SafeCDKit, tx: Transaction): string {
	return `${safeTxLinkByNetwork[scdk.network]}${tx.safe}&id=multisig_${tx.safe}_${tx.safeTxHash}`;
}

let namingMap: { [key: string]: string };

function getNameAndType(scdk: SafeCDKit, address: string): string {
	if (namingMap === undefined) {
		namingMap = {};
		for (let eoaIdx = 0; eoaIdx < scdk.state.eoas.length; ++eoaIdx) {
			const loadedEOA: EOA = scdk.state.eoas[eoaIdx].entity as EOA;
			namingMap[utils.getAddress(loadedEOA.address)] = `<code><a href="${getAddressExplorerLink(
				scdk,
				loadedEOA.address
			)}" target="_blank">eoa@${loadedEOA.name}</a></code>`;
		}

		for (let safeIdx = 0; safeIdx < scdk.state.safes.length; ++safeIdx) {
			const safe: PopulatedSafe = scdk.state.safes[safeIdx].entity as PopulatedSafe;
			namingMap[utils.getAddress(safe.address)] = `<code><a href="${getAddressExplorerLink(
				scdk,
				safe.address
			)}" target="_blank">safe@${safe.name}</a></code>`;
		}
	}

	if (namingMap[utils.getAddress(address)]) {
		return namingMap[utils.getAddress(address)];
	}

	return `<code><a href="${getAddressExplorerLink(scdk, address)}" target="_blank">${address}</a></code>`;
}

function getAllSafeTransactions(scdk: SafeCDKit, safe: PopulatedSafe): Transaction[] {
	const txIds = scdk.state.transactionBySafe[utils.getAddress(safe.address)];
	if (!txIds) {
		return [];
	}
	return txIds
		.map(txIndex => scdk.state.transactions[txIndex].entity as Transaction)
		.sort((a: Transaction, b: Transaction) => b.submissionDate.localeCompare(a.submissionDate));
}

function generateSafesDiagram(scdk: SafeCDKit): string {
	let content = 'flowchart LR\nsubgraph Overview\ndirection LR\n';
	const done = {};
	let index = 0;
	for (let safeIndex = 0; safeIndex < scdk.state.safes.length; ++safeIndex) {
		const safe: PopulatedSafe = scdk.state.safes[safeIndex].entity as PopulatedSafe;
		const [res, newIndex] = generateSafeDiagram(scdk, safe, index, done);
		content += res;
		index = newIndex;
	}
	content += 'end\n';
	return content;
}

var colors = require('nice-color-palettes');

function getScore(color: string): number {
	return parseInt(color.slice(1, 3), 16) + parseInt(color.slice(3, 5), 16) + parseInt(color.slice(5, 7), 16);
}

const Color = require('color');

function lightAndDark(address: string): [string, string] {
	const index = parseInt(utils.getAddress(address).slice(2, 8), 16);
	const palette = colors[index % colors.length];
	let lightest = Color(palette[index % palette.length]).lightness(10);
	let darkest = Color(palette[index % palette.length]);
	while (Math.abs(getScore(lightest.hex()) - getScore(darkest.hex())) < 200) {
		lightest = lightest.lighten(0.01);
		darkest = darkest.darken(0.01);
	}
	if (parseInt(utils.getAddress(address).slice(8, 10), 16) % 2 == 0) {
		return [lightest.hex(), darkest.hex()];
	}
	return [darkest.hex(), lightest.hex()];
}

function generateSafeDiagram(
	scdk: SafeCDKit,
	safe: PopulatedSafe,
	linkIndex: number,
	done: { [key: string]: boolean }
): [string, number] {
	let content = '';
	if (done[safe.address]) {
		return [content, linkIndex];
	}
	done[safe.address] = true;

	let internalIdx = 0;
	const [safeLight, safeDark] = lightAndDark(safe.address);
	for (const owner of safe.owners) {
		const [light, dark] = lightAndDark(owner);
		const ownerSafe = getSafe(owner, scdk);
		if (ownerSafe !== null) {
			content += `${owner}{{${getNames(scdk, owner).join(', ')}<br/>type=safe,threshold=${
				ownerSafe.threshold
			}<br/>${owner}}} =====>|owner| ${safe.address}{{${safe.name}<br/>type=safe,threshold=${
				safe.threshold
			}<br/>${safe.address}}}\n`;
		} else {
			content += `${owner}(${getNames(scdk, owner).join(', ')}<br/>type=eoa<br/>${owner}) =====>|owner| ${
				safe.address
			}{{${safe.name}<br/>type=safe,threshold=${safe.threshold}<br/>${safe.address}}}\n`;
		}
		content += `style ${owner} fill:${light},color:${dark},stroke:${dark},stroke-width:4px\n`;
		content += `linkStyle ${linkIndex + internalIdx} stroke:${dark},stroke-width:4px\n`;
		++internalIdx;
	}

	for (const delegate of safe.delegates) {
		const delegateAddress = delegate.delegate;
		const delegateSafe = getSafe(delegateAddress, scdk);
		const [light, dark] = lightAndDark(delegateAddress);
		if (delegateSafe !== null) {
			content += `${delegateAddress}{{${getNames(scdk, delegateAddress).join(', ')}<br/>type=safe,threshold=${
				delegateSafe.threshold
			},label=${delegate.label}<br/>${delegateAddress}}} -...->|delegate| ${safe.address}{{${
				safe.name
			}<br/>type=safe,threshold=${safe.threshold}<br/>${safe.address}}}\n`;
		} else {
			content += `${delegateAddress}(${getNames(scdk, delegateAddress).join(', ')}<br/>type=eoa,label=${
				delegate.label
			}<br/>${delegateAddress}) -...->|delegate| ${safe.address}{{${safe.name}<br/>type=safe,threshold=${
				safe.threshold
			}<br/>${safe.address}}}\n`;
		}
		content += `style ${delegateAddress} fill:${light},color:${dark},stroke:${dark},stroke-width:4px\n`;
		content += `linkStyle ${linkIndex + internalIdx} stroke:${dark},stroke-width:4px\n`;
		++internalIdx;
	}
	content += `style ${safe.address} fill:${safeLight},color:${safeDark},stroke:${safeDark},stroke-width:4px\n`;

	return [content, linkIndex + internalIdx];
}

function getNames(scdk: SafeCDKit, address: string): string[] {
	let names = [];
	for (const eoa of scdk.state.eoas) {
		if (utils.getAddress(eoa.entity.address) === utils.getAddress(address)) {
			names.push(eoa.entity.name);
		}
	}

	for (const safeConfig of scdk.state.safes) {
		if (utils.getAddress(safeConfig.entity.address) === utils.getAddress(address)) {
			names.push(safeConfig.entity.name);
		}
	}

	return names;
}

function getSafe(address: string, scdk: SafeCDKit): PopulatedSafe | null {
	return scdk.state.getSafeByAddress(address);
}
