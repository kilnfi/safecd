var gitDiff = require('git-diff')
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, relative, resolve } from 'path';
export class CacheFS {
	private edits: { [key: string]: string | null } = {};

	read(file: string): string {
		file = resolve(file)
		return this.edits[file] || readFileSync(file, 'utf8');
	}

	write(file: string, content: string): void {
		file = resolve(file)
		if (existsSync(file) && this.read(file) === content) {
			delete this.edits[file];
			return;
		}
		this.edits[file] = content;
	}

	remove(file: string): void {
		file = resolve(file)
		this.edits[file] = null;
	}

	printDiff(): void {
		for (let [file, content] of Object.entries(this.edits)) {
			const diff = gitDiff(
				existsSync(file) ? readFileSync(file, { encoding: "utf8" }) : "",
				content || "", { color: true, forceFake: true })
			if (diff !== undefined) {
				console.log(`${file}:`);
				console.log();
				console.log(diff);
				console.log();
			}
		}
	}

	commit(write: boolean): void {
		if (!write) {
			return;
		}
		let COMMIT_MSG = "";
		let editionCount = 0;
		let deletionCount = 0;
		let creationCount = 0;
		for (const [file, content] of Object.entries(this.edits)) {
			if (content === null) {
				if (existsSync(file)) {
					COMMIT_MSG += `- delete ${relative(".", file)}\n`;
					++deletionCount;
				}
				console.log(`deleting ${file}.`);
				unlinkSync(file);
			} else {
				if (!existsSync(file)) {
					COMMIT_MSG += `- create ${relative(".", file)}\n`;
					++creationCount;
				} else if (readFileSync(file, { encoding: "utf8" }) !== content) {
					COMMIT_MSG += `- edit   ${relative(".", file)}\n`;
					++editionCount;
				}
				console.log(`writting ${file}.`);
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, content, { encoding: "utf8" });
			}
		}
		if (COMMIT_MSG !== "") {
			COMMIT_MSG = `safecd: create=${creationCount} edit=${editionCount} delete=${deletionCount}\n\n${COMMIT_MSG}`
			writeFileSync("COMMIT_MSG", COMMIT_MSG, { encoding: "utf8" })
		} else if (existsSync("COMMIT_MSG")) {
			unlinkSync("COMMIT_MSG");
		}
	}
}