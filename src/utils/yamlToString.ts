import YAML from 'yaml';
export function yamlToString(yaml: any) {
	return YAML.stringify(yaml, { lineWidth: 0, sortMapEntries: true });
}
