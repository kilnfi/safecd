import { Block, KnownBlock, MessageAttachment, WebClient } from '@slack/web-api';
import { utils } from 'ethers';
import { keccak256 } from 'ethers/lib/utils';
import { State } from '../state';
import { EOA, PopulatedSafe, Proposal, SafeCDKit, Transaction } from '../types';
import { yamlToString } from '../utils/yamlToString';

const safeTxLinkByNetwork: { [key: string]: string } = {
	mainnet: 'https://app.safe.global/transactions/tx?safe=eth:',
	goerli: 'https://app.safe.global/transactions/tx?safe=gor:'
};

const explorerByNetwork: { [key: string]: string } = {
	mainnet: 'https://etherscan.io',
	goerli: 'https://goerli.etherscan.io'
};

function getSafeTxLink(scdk: SafeCDKit, tx: Transaction): string {
	return `${safeTxLinkByNetwork[scdk.network]}${tx.safe}&id=multisig_${tx.safe}_${tx.safeTxHash}`;
}

function getSafeTxLinkOnNetwork(network: string, tx: Transaction): string {
	return `${safeTxLinkByNetwork[network]}${tx.safe}&id=multisig_${tx.safe}_${tx.safeTxHash}`;
}

function getAddressExplorerLink(scdk: SafeCDKit, address: string): string {
	return `${explorerByNetwork[scdk.network]}/address/${address}`;
}

function getTxExplorerLink(scdk: SafeCDKit, tx: Transaction): string {
	return `${explorerByNetwork[scdk.network]}/tx/${tx.transactionHash}`;
}

export async function syncProposals(scdk: SafeCDKit): Promise<void> {
	for (let proposalIdx = 0; proposalIdx < scdk.state.proposals.length; ++proposalIdx) {
		const proposal = scdk.state.proposals[proposalIdx].entity;
		if (proposal.safeTxHash && proposal.notifications) {
			const transaction = scdk.state.getTransactionByHash(proposal.safeTxHash);
			if (!transaction) {
				continue;
			}
			const rejection = getRejectionTransaction(scdk, transaction);
			const safe = scdk.state.getSafeByAddress(proposal.safe) as PopulatedSafe;
			if (!safe) {
				continue;
			}
			const { notifications, ...hashableProposal } = proposal;
			const hash = utils.hashMessage(
				yamlToString(hashableProposal) +
					yamlToString(transaction) +
					yamlToString(rejection || {}) +
					'THRESHOLD=' +
					safe.threshold.toString()
			);
			if (proposal.notifications.slack) {
				const updatedSlackNotifications = [];
				for (const msg of proposal.notifications.slack) {
					if (hash.toLowerCase() !== msg.hash?.toLowerCase()) {
						try {
							if (msg.hash === undefined) {
								const slack = await getWebClient();
								const msgs = await slack.conversations.history({
									channel: msg.channel
								});
								if (msgs && msgs.messages) {
									const botInfo = await slack.auth.test();
									const msgHash = keccak256(transaction.safeTxHash.toLowerCase()).toLocaleLowerCase();
									if (botInfo.bot_id) {
										for (const slMsg of msgs.messages) {
											if (
												slMsg.bot_id &&
												slMsg.bot_id.toLowerCase() === botInfo.bot_id.toLowerCase()
											) {
												if (slMsg.attachments && slMsg.attachments.length > 0) {
													const lastAttachment =
														slMsg.attachments[slMsg.attachments.length - 1];
													if (lastAttachment.blocks && lastAttachment.blocks.length > 0) {
														const lastBlock =
															lastAttachment.blocks[lastAttachment.blocks.length - 1];
														if (
															lastBlock.type === 'section' &&
															lastBlock.text &&
															lastBlock.text.type === 'mrkdwn' &&
															lastBlock.text.text &&
															lastBlock.text.text.includes(msgHash)
														) {
															msg.message = slMsg.ts as string;
															console.log(
																`Found slack message for proposal ${proposal.title}`
															);
														}
													}
												}
											}
										}
									}
								}
							}
							const id = await notifySlack(
								scdk,
								proposal,
								transaction,
								rejection,
								safe,
								msg.channel,
								msg.message
							);
							if (id !== null) {
								msg.hash = hash.toLowerCase();
								msg.message = id;
							}
							if (!(transaction.isExecuted || (rejection && rejection.isExecuted))) {
								updatedSlackNotifications.push(msg);
							}
						} catch (e) {
							console.error('An error occured while trying to post slack notification');
							console.error(e);
						}
					} else {
						updatedSlackNotifications.push(msg);
					}
				}
				notifications.slack = updatedSlackNotifications;
			}
			proposal.notifications = notifications;
			scdk.state.writeProposal(proposalIdx, proposal);
		}
	}
}

let slackClient: WebClient;

async function getWebClient(): Promise<WebClient> {
	if (!slackClient) {
		const token = process.env.SLACK_BOT_TOKEN;
		if (!token) {
			throw new Error('SLACK_BOT_TOKEN not set');
		}
		slackClient = new WebClient(token);
	}
	return slackClient;
}

export const notifySlack = async (
	scdk: SafeCDKit,
	proposal: Proposal,
	transaction: Transaction,
	rejection: Transaction | null,
	safe: PopulatedSafe,
	channel: string,
	msgId: string | undefined
): Promise<string | null> => {
	const slack = await getWebClient();
	if (scdk.shouldUpload && scdk.shouldWrite) {
		if (msgId === undefined) {
			const newMsg = await slack.chat.postMessage({
				channel,
				...formatProposalSlackMessage(scdk, proposal, transaction, rejection, safe)
			});
			return newMsg.ts as string;
		}

		await slack.chat.update({
			channel,
			ts: msgId,
			...formatProposalSlackMessage(scdk, proposal, transaction, rejection, safe)
		});

		return msgId;
	} else {
		console.log(`Notification for proposal ${proposal.title} would be sent to slack`);
	}
	return null;
};

interface MessagePayload {
	blocks: (KnownBlock | Block)[];
	attachments: MessageAttachment[];
	text: string;
	icon_url: string;
	username: string;
	unfurl_links: boolean;
	unfurl_media: boolean;
}

function getTxDecoding(tx: Transaction): string {
	if (tx.dataDecoded?.method) {
		return `\`\`\`

${tx.dataDecoded.method}(
  ${tx.dataDecoded.parameters?.map((p: any) => `${p.name}: ${p.type}`).join(',\n  ') || ''}
)

\`\`\``;
	}
	return `\`\`\`
${tx.data || '0x'}
\`\`\``;
}

const getSigners = (
	scdk: SafeCDKit,
	safe: PopulatedSafe,
	transaction: Transaction,
	rejection: Transaction | null
): [string[], string[], string[]] => {
	let missingSigners: string[] = [];
	for (const owner of safe.owners) {
		let eoa = scdk.state.getEOAByAddress(owner);
		if (eoa === null) {
			const safeOwner = scdk.state.getSafeByAddress(owner);
			if (safeOwner === null) {
				missingSigners.push(
					`<${getAddressExplorerLink(scdk, utils.getAddress(owner))}|${utils.getAddress(owner)}>`
				);
			} else {
				missingSigners.push(`<${getAddressExplorerLink(scdk, safeOwner.address)}|${safeOwner.name} (safe)>`);
			}
		} else {
			missingSigners.push(`<${getAddressExplorerLink(scdk, eoa.address)}|${eoa.name}>`);
		}
	}
	let confirmationSigners: string[] = [];
	for (const confirmation of transaction.confirmations) {
		let eoa = scdk.state.getEOAByAddress(confirmation.owner);
		if (eoa === null) {
			const safeOwner = scdk.state.getSafeByAddress(confirmation.owner);
			if (safeOwner === null) {
				confirmationSigners.push(
					`<${getAddressExplorerLink(scdk, utils.getAddress(confirmation.owner))}|${utils.getAddress(
						confirmation.owner
					)}>`
				);
			} else {
				confirmationSigners.push(
					`<${getAddressExplorerLink(scdk, safeOwner.address)}|${safeOwner.name} (safe)>`
				);
			}
		} else {
			confirmationSigners.push(`<${getAddressExplorerLink(scdk, eoa.address)}|${eoa.name}>`);
		}
	}
	let rejectionSigners: string[] = [];
	if (rejection !== null) {
		for (const confirmation of rejection.confirmations) {
			let eoa = scdk.state.getEOAByAddress(confirmation.owner);
			if (eoa === null) {
				const safeOwner = scdk.state.getSafeByAddress(confirmation.owner);
				if (safeOwner === null) {
					rejectionSigners.push(
						`<${getAddressExplorerLink(scdk, utils.getAddress(confirmation.owner))}|${utils.getAddress(
							confirmation.owner
						)}>`
					);
				} else {
					rejectionSigners.push(
						`<${getAddressExplorerLink(scdk, safeOwner.address)}|${safeOwner.name} (safe)>`
					);
				}
			} else {
				rejectionSigners.push(`<${getAddressExplorerLink(scdk, eoa.address)}|${eoa.name}>`);
			}
		}
	}
	missingSigners = missingSigners.filter(
		s => confirmationSigners.indexOf(s) === -1 && rejectionSigners.indexOf(s) === -1
	);
	return [missingSigners, confirmationSigners, rejectionSigners];
};

function getAddress(scdk: SafeCDKit, address: string): string {
	const eoa = scdk.state.getEOAByAddress(address);
	if (eoa !== null) {
		return `<${getAddressExplorerLink(scdk, eoa.address)}|\`${eoa.name}\`>`;
	}
	const safe = scdk.state.getSafeByAddress(address);
	if (safe !== null) {
		return `<${getAddressExplorerLink(scdk, safe.address)}|\`${safe.name} (safe)\`>`;
	}
	return `<${getAddressExplorerLink(scdk, address)}|\`${address}\`>`;
}

function getRejectionTransaction(scdk: SafeCDKit, transaction: Transaction): Transaction | null {
	const otherSafeTransactions = scdk.state.transactionBySafe[utils.getAddress(transaction.safe)].map(
		txIdx => scdk.state.transactions[txIdx]
	);
	for (const otherSafeTransaction of otherSafeTransactions) {
		if (
			otherSafeTransaction.entity.nonce === transaction.nonce &&
			utils.getAddress(otherSafeTransaction.entity.to) === utils.getAddress(transaction.safe) &&
			otherSafeTransaction.entity.value === '0' &&
			otherSafeTransaction.entity.data === null &&
			otherSafeTransaction.entity.safeTxHash?.toLowerCase() !== transaction.safeTxHash?.toLowerCase()
		) {
			return otherSafeTransaction.entity;
		}
	}
	return null;
}

const getStatusTextAndColor = (
	transaction: Transaction,
	rejection: Transaction | null,
	safe: PopulatedSafe
): [string, string] => {
	if (rejection !== null) {
		if (rejection.isExecuted) {
			return ['Proposal was rejected onchain', '#e03b24'];
		}
	}
	if (transaction.isExecuted) {
		return ['Proposal was executed onchain', '#0275d8'];
	}
	if (transaction.confirmations.length >= safe.threshold) {
		return ['Proposal is ready to be executed', '#64a338'];
	}
	return ['Proposal is not ready to be executed', '#ffcc00'];
};

const formatProposalSlackMessage = (
	scdk: SafeCDKit,
	proposal: Proposal,
	transaction: Transaction,
	rejection: Transaction | null,
	safe: PopulatedSafe
): MessagePayload => {
	const [missingSigners, confirmationSigners, rejectionSigners] = getSigners(scdk, safe, transaction, rejection);
	const [statusMessage, statusColor] = getStatusTextAndColor(transaction, rejection, safe);

	return {
		blocks: [
			{
				type: 'context',
				elements: [
					{
						type: 'plain_text',
						text: statusMessage
					}
				]
			}
		],
		attachments: [
			{
				blocks: [
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `<!here> *${proposal.title}*
						
${proposal.description || ''}
`
						}
					},
					{
						type: 'divider'
					},
					...(transaction.isExecuted || (rejection && rejection.isExecuted)
						? []
						: ([
								{
									type: 'section',
									fields: [
										{
											type: 'mrkdwn',
											text: `<${getSafeTxLink(scdk, transaction)}|✅ *Click to approve* ✅>`
										},
										{
											type: 'mrkdwn',
											text: `<${getSafeTxLink(
												scdk,
												rejection || transaction
											)}|❌ *Click to reject* ❌>`
										}
									]
								},
								{
									type: 'divider'
								}
						  ] as (KnownBlock | Block)[])),

					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*Missing Signers*:\n${
								missingSigners.length === 0
									? 'All signers have signed'
									: `\`${missingSigners.join('`, `')}\``
							}`
						}
					},
					{
						type: 'section',
						fields: [
							{
								type: 'mrkdwn',
								text:
									'*Confirmations:*\n' +
									getConfirmationIcons(transaction.confirmations.length, safe.threshold)
							},
							{
								type: 'mrkdwn',
								text: `*Signers*:\n${
									confirmationSigners.length === 0
										? 'No confirmations'
										: `\`${confirmationSigners.join('`, `')}\``
								}`
							}
						]
					},
					...(rejection !== null
						? ([
								{
									type: 'section',
									fields: [
										{
											type: 'mrkdwn',
											text:
												'*Rejections:*\n' +
												getRejectionIcons(rejection.confirmations.length, safe.threshold)
										},
										{
											type: 'mrkdwn',
											text: `*Signers*:\n${
												rejectionSigners.length === 0
													? 'No rejections'
													: `\`${rejectionSigners.join('`, `')}\``
											}`
										}
									]
								}
						  ] as (KnownBlock | Block)[])
						: []),
					{
						type: 'divider'
					},
					{
						type: 'section',
						fields: [
							{
								type: 'mrkdwn',
								text: `*From*:\n${getAddress(scdk, transaction.safe)}`
							},
							{
								type: 'mrkdwn',
								text: `*To*:\n${getAddress(scdk, transaction.to)}`
							}
						]
					},
					{
						type: 'section',
						fields: [
							{
								type: 'mrkdwn',
								text: '*Value:*\n' + utils.formatEther(transaction.value) + ' ETH'
							},
							{
								type: 'mrkdwn',
								text: '*Nonce:*\n' + transaction.nonce
							}
						]
					},
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*Data*:
${getTxDecoding(transaction)}`
						}
					},
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*Safe Transaction Hash*:\n<${getSafeTxLink(scdk, transaction)}|\`${
								transaction.safeTxHash
							}\`>`
						}
					},
					...(rejection !== null
						? ([
								{
									type: 'section',
									text: {
										type: 'mrkdwn',
										text: `*Safe Rejection Transaction Hash*:\n<${getSafeTxLink(
											scdk,
											rejection
										)}|\`${rejection.safeTxHash}\`>`
									}
								}
						  ] as (KnownBlock | Block)[])
						: []),
					...(transaction.isExecuted
						? ([
								{
									type: 'section',
									text: {
										type: 'mrkdwn',
										text: `*Transaction Hash*:\n<${getTxExplorerLink(scdk, transaction)}|\`${
											transaction.transactionHash
										}\`>`
									}
								}
						  ] as (KnownBlock | Block)[])
						: []),
					...(rejection && rejection.isExecuted
						? ([
								{
									type: 'section',
									text: {
										type: 'mrkdwn',
										text: `*Rejection Transaction Hash*:\n<${getTxExplorerLink(
											scdk,
											rejection
										)}|\`${rejection.transactionHash}\`>`
									}
								}
						  ] as (KnownBlock | Block)[])
						: []),
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `\`id=${keccak256(transaction.safeTxHash.toLowerCase()).toLocaleLowerCase()}\``
						}
					}
				],
				color: statusColor
			}
		],
		text: proposal.title,
		icon_url: 'https://www.pngall.com/wp-content/uploads/10/Ethereum-Logo-PNG-Pic.png',
		username: `safecd - ${safe.name}`,
		unfurl_links: false,
		unfurl_media: false
	};
};

function getConfirmationIcons(confirmationCount: number, threshold: number): string {
	return '🟩'.repeat(confirmationCount) + '⬜️'.repeat(threshold - confirmationCount);
}

function getRejectionIcons(confirmationCount: number, threshold: number): string {
	return '🟥'.repeat(confirmationCount) + '⬜️'.repeat(threshold - confirmationCount);
}

export const handleNotifications = async (scdk: SafeCDKit): Promise<void> => {
	await syncProposals(scdk);
};

const colorBasedOnTime = (minutes: number): string => {
	if (minutes < 60) {
		return '#339900';
	}
	if (minutes < 60 * 4) {
		return '#99cc33';
	}
	if (minutes < 60 * 8) {
		return '#ffcc00';
	}
	if (minutes < 60 * 12) {
		return '#ff9966';
	}
	return '#cc3300';
};

const craftReminder = (proposals: Proposal[], state: State, eoa: EOA, network: string): any => {
	return {
		attachments: [
			{
				blocks: [
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*Pending Proposals*:\n\`${proposals.length}\``
						}
					},
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*EOA*:\n\`${eoa.name}\``
						}
					}
				]
			},
			...proposals
				.map(proposal => {
					const safe = state.getSafeByAddress(proposal.safe);
					const transaction = state.getTransactionByHash(proposal.safeTxHash!);
					const timeSinceSubmission = Math.floor(
						(Date.now() - new Date(transaction!.submissionDate).getTime()) / 1000 / 60
					);
					return {
						blocks: [
							{
								type: 'section',
								text: {
									type: 'mrkdwn',
									text: `*Title*:\n${proposal.title}`
								}
							},
							{
								type: 'section',
								text: {
									type: 'mrkdwn',
									text: `*Description*:\n${proposal.description}`
								}
							},
							{
								type: 'section',
								fields: [
									{
										type: 'mrkdwn',
										text: `*From*:\n\`${safe!.name}\``
									},
									{
										type: 'mrkdwn',
										text: `*To*:\n${transaction!.to}`
									}
								]
							},
							{
								type: 'section',
								text: {
									type: 'mrkdwn',
									text: `<${getSafeTxLinkOnNetwork(network, transaction!)}|*CLICK TO APPROVE*>`
								}
							}
						],
						color: colorBasedOnTime(timeSinceSubmission)
					};
				})
				.flat()
		],
		text: `<!here> You have ${proposals.length} pending proposals !`,
		username: `safecd reminders`,
		unfurl_links: false,
		unfurl_media: false
	};
};

export const handleReminders = async (users: string, state: State, shouldWrite: boolean): Promise<void> => {
	const userList = users.split(';') || [];
	const slack = await getWebClient();
	for (const user of userList) {
		const [eoa, slackId, timezone] = user.split(':');
		const options = {
			timeZone: timezone,
			hour: '2-digit',
			hour12: false
		};
		const hour = parseInt(new Intl.DateTimeFormat([], options as any).format(new Date()));
		console.log(`Checking is it's time for reminders for ${eoa} in ${timezone}`);
		if (![10, 14, 18].includes(hour)) {
			continue;
		}
		console.log(`Computing reminders for ${eoa} in ${timezone}`);
		const eoaEntity = state.getEOAByAddress(eoa);
		if (eoaEntity === null) {
			throw new Error(`EOA ${eoa} not found`);
		}
		const proposals = state.getPendingProposalsByOwner(eoa);
		if (proposals.length === 0) {
			continue;
		}
		const msg = craftReminder(proposals, state, eoaEntity, state.config.network);
		if (shouldWrite) {
			const conv = await slack.conversations.open({
				users: slackId
			});
			await slack.chat.postMessage({
				channel: conv.channel?.id || slackId,
				...msg
			});
			console.log(`Reminder for ${eoaEntity.name} sent to slack`);
		} else {
			console.log(`Reminder for ${eoaEntity.name} would be sent to slack`);
		}
	}
};
