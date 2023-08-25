export interface Proposal {
	title: string;
	description?: string;
	safe: string;
	delegate: string;
	proposal: string;
	function: string;
	nonce?: number;
	arguments?: string[];
	safeTxHash?: string;
}

export function validateProposal(proposal: any): Proposal {
	if (!proposal.title) {
		throw new Error('Missing title in proposal');
	}
	if (!proposal.safe) {
		throw new Error('Missing safe address in proposal');
	}
	if (!proposal.delegate) {
		throw new Error('Missing delegate address in proposal');
	}
	if (!proposal.proposal) {
		throw new Error('Missing proposal address in proposal');
	}
	if (!proposal.function) {
		throw new Error('Missing function in proposal');
	}
	return proposal as Proposal;
}
