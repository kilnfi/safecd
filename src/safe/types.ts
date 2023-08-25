export interface Address {
	type: string;
	name: string;
	address: string;
}

export interface Safe extends Address {
	type: 'safe';
	description?: string;
}

export const validateSafe = (file: string, safe: any): Safe => {
	if (!safe.address) {
		throw new Error(`Missing safe address in ${file}`);
	}
	if (!safe.name) {
		throw new Error(`Missing safe name in ${file}`);
	}
	safe.type = 'safe';
	return safe as Safe;
};

export const validatePopulatedSafe = (file: string, safe: any): PopulatedSafe => {
	if (!safe.address) {
		throw new Error(`Missing safe address in ${file}`);
	}
	if (!safe.name) {
		throw new Error(`Missing safe name in ${file}`);
	}
	if (!safe.owners) {
		throw new Error(`Missing safe owners in ${file}`);
	}
	if (!safe.delegates) {
		throw new Error(`Missing safe delegates in ${file}`);
	}
	if (!safe.threshold) {
		throw new Error(`Missing safe threshold in ${file}`);
	}
	safe.type = 'safe';
	return safe as PopulatedSafe;
};

export interface Delegate {
	delegate: string;
	delegator: string;
	label: string;
}

export interface PopulatedSafe extends Safe {
	owners: string[];
	delegates: Delegate[];
	threshold: number;
	nonce: number;
	version: string;
}

export interface EOA extends Address {
	type: 'eoa';
	description?: string;
}
