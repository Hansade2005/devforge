/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import v8 from 'node:v8';
import fs from 'fs';
import path from 'path';
import { argv } from 'process';
import { Mapping, SourceMapGenerator } from 'source-map';
import ts from 'typescript';
import { pathToFileURL } from 'url';
import workerpool from 'workerpool';
import { StaticLanguageServiceHost } from './staticLanguageServiceHost';
const buildfile = require('../../buildfile');

class ShortIdent {

	private static _keywords = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
		'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
		'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw',
		'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);

	private static _alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890$_'.split('');

	private _value = 0;

	constructor(
		private readonly prefix: string
	) { }

	next(isNameTaken?: (name: string) => boolean): string {
		const candidate = this.prefix + ShortIdent.convert(this._value);
		this._value++;
		if (ShortIdent._keywords.has(candidate) || /^[_0-9]/.test(candidate) || isNameTaken?.(candidate)) {
			// try again
			return this.next(isNameTaken);
		}
		return candidate;
	}

	private static convert(n: number): string {
		const base = this._alphabet.length;
		let result = '';
		do {
			const rest = n % base;
			result += this._alphabet[rest];
			n = (n / base) | 0;
		} while (n > 0);
		return result;
	}
}

const enum FieldType {
	Public,
	Protected,
	Private
}

class ClassData {

	fields = new Map<string, { type: FieldType; pos: number }>();

	private replacements: Map<string, string> | undefined;

	parent: ClassData | undefined;
	children: ClassData[] | undefined;

	constructor(
		readonly fileName: string,
		readonly node: ts.ClassDeclaration | ts.ClassExpression,
	) {
		// analyse all fields (properties and methods). Find usages of all protected and
		// private ones and keep track of all public ones (to prevent naming collisions)

		const candidates: (ts.NamedDeclaration)[] = [];
		for (const member of node.members) {
			if (ts.isMethodDeclaration(member)) {
				// method `foo() {}`
				candidates.push(member);

			} else if (ts.isPropertyDeclaration(member)) {
				// property `foo = 234`
				candidates.push(member);

			} else if (ts.isGetAccessor(member)) {
				// getter: `get foo() { ... }`
				candidates.push(member);

			} else if (ts.isSetAccessor(member)) {
				// setter: `set foo() { ... }`
				candidates.push(member);

			} else if (ts.isConstructorDeclaration(member)) {
				// constructor-prop:`constructor(private foo) {}`
				for (const param of member.parameters) {
					if (hasModifier(param, ts.SyntaxKind.PrivateKeyword)
						|| hasModifier(param, ts.SyntaxKind.ProtectedKeyword)
						|| hasModifier(param, ts.SyntaxKind.PublicKeyword)
						|| hasModifier(param, ts.SyntaxKind.ReadonlyKeyword)
					) {
						candidates.push(param);
					}
				}
			}
		}
		for (const member of candidates) {
			const ident = ClassData._getMemberName(member);
			if (!ident) {
				continue;
			}
			const type = ClassData._getFieldType(member);
			this.fields.set(ident, { type, pos: member.name!.getStart() });
		}
	}

	private static _getMemberName(node: ts.NamedDeclaration): string | undefined {
		if (!node.name) {
			return undefined;
		}
		const { name } = node;
		let ident = name.getText();
		if (name.kind === ts.SyntaxKind.ComputedPropertyName) {
			if (name.expression.kind !== ts.SyntaxKind.StringLiteral) {
				// unsupported: [Symbol.foo] or [abc + 'field']
				return;
			}
			// ['foo']
			ident = name.expression.getText().slice(1, -1);
		}

		return ident;
	}

	private static _getFieldType(node: ts.Node): FieldType {
		if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) {
			return FieldType.Private;
		} else if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) {
			return FieldType.Protected;
		} else {
			return FieldType.Public;
		}
	}

	static _shouldMangle(type: FieldType): boolean {
		return type === FieldType.Private
			|| type === FieldType.Protected
			;
	}

	static makeImplicitPublicActuallyPublic(data: ClassData, reportViolation: (name: string, what: string, why: string) => void): void {
		// TS-HACK
		// A subtype can make an inherited protected field public. To prevent accidential
		// mangling of public fields we mark the original (protected) fields as public...
		for (const [name, info] of data.fields) {
			if (info.type !== FieldType.Public) {
				continue;
			}
			let parent: ClassData | undefined = data.parent;
			while (parent) {
				if (parent.fields.get(name)?.type === FieldType.Protected) {
					const parentPos = parent.node.getSourceFile().getLineAndCharacterOfPosition(parent.fields.get(name)!.pos);
					const infoPos = data.node.getSourceFile().getLineAndCharacterOfPosition(info.pos);
					reportViolation(name, `'${name}' from ${parent.fileName}:${parentPos.line + 1}`, `${data.fileName}:${infoPos.line + 1}`);

					parent.fields.get(name)!.type = FieldType.Public;
				}
				parent = parent.parent;
			}
		}
	}

	static fillInReplacement(data: ClassData) {

		if (data.replacements) {
			// already done
			return;
		}

		// fill in parents first
		if (data.parent) {
			ClassData.fillInReplacement(data.parent);
		}

		data.replacements = new Map();

		const isNameTaken = (name: string) => {
			// locally taken
			if (data._isNameTaken(name)) {
				return true;
			}

			// parents
			let parent: ClassData | undefined = data.parent;
			while (parent) {
				if (parent._isNameTaken(name)) {
					return true;
				}
				parent = parent.parent;
			}

			// children
			if (data.children) {
				const stack = [...data.children];
				while (stack.length) {
					const node = stack.pop()!;
					if (node._isNameTaken(name)) {
						return true;
					}
					if (node.children) {
						stack.push(...node.children);
					}
				}
			}

			return false;
		};

		// Create a short identifier generator
		const identPool = new ShortIdent('');

		// Sort fields by usage count to assign shortest names to most used fields
		const fieldsArray = Array.from(data.fields.entries())
			.filter(([_, info]) => ClassData._shouldMangle(info.type));

		// Sort by usage count (if available) in descending order
		fieldsArray.sort((a, b) => {
			const countA = (a[1] as any).usageCount || 0;
			const countB = (b[1] as any).usageCount || 0;
			return countB - countA;
		});

		// Assign names by frequency (most frequent gets shortest names)
		for (const [name, info] of fieldsArray) {
			const shortName = identPool.next(isNameTaken);
			data.replacements.set(name, shortName);
		}
	}

	// a name is taken when a field that doesn't get mangled exists or
	// when the name is already in use for replacement
	private _isNameTaken(name: string) {
		if (this.fields.has(name) && !ClassData._shouldMangle(this.fields.get(name)!.type)) {
			// public field
			return true;
		}
		if (this.replacements) {
			for (const shortName of this.replacements.values()) {
				if (shortName === name) {
					// replaced already (happens wih super types)
					return true;
				}
			}
		}

		if (isNameTakenInFile(this.node, name)) {
			return true;
		}

		return false;
	}

	lookupShortName(name: string): string {
		let value = this.replacements!.get(name)!;
		let parent = this.parent;
		while (parent) {
			if (parent.replacements!.has(name) && parent.fields.get(name)?.type === FieldType.Protected) {
				value = parent.replacements!.get(name)! ?? value;
			}
			parent = parent.parent;
		}
		return value;
	}

	// --- parent chaining

	addChild(child: ClassData) {
		this.children ??= [];
		this.children.push(child);
		child.parent = this;
	}
}

function isNameTakenInFile(node: ts.Node, name: string): boolean {
	const identifiers = (<any>node.getSourceFile()).identifiers;
	if (identifiers instanceof Map) {
		if (identifiers.has(name)) {
			return true;
		}
	}
	return false;
}

// Constants for path filtering
const NODE_MODULES_PATTERN = /node_modules/;
const D_TS_PATTERN = /\.d\.ts$/;

const skippedExportMangledFiles = [
	// Build
	'css.build',

	// Monaco
	'editorCommon',
	'editorOptions',
	'editorZoom',
	'standaloneEditor',
	'standaloneEnums',
	'standaloneLanguages',

	// Generated
	'extensionsApiProposals',

	// Module passed around as type
	'pfs',

	// entry points
	...[
		buildfile.workerEditor,
		buildfile.workerExtensionHost,
		buildfile.workerNotebook,
		buildfile.workerLanguageDetection,
		buildfile.workerLocalFileSearch,
		buildfile.workerProfileAnalysis,
		buildfile.workerOutputLinks,
		buildfile.workerBackgroundTokenization,
		buildfile.workbenchDesktop,
		buildfile.workbenchWeb,
		buildfile.code,
		buildfile.codeWeb
	].flat().map(x => x.name),
];

const skippedExportMangledProjects = [
	// Test projects
	'vscode-api-tests',

	// These projects use webpack to dynamically rewrite imports, which messes up our mangling
	'configuration-editing',
	'microsoft-authentication',
	'github-authentication',
	'html-language-features/server',
	'google-auth-library', // Exclude Google Auth Library to prevent overlapping edits

];

const skippedExportMangledSymbols = [
	// Don't mangle extension entry points
	'activate',
	'deactivate',
];

class DeclarationData {

	readonly replacementName: string;
	usageCount: number = 0; // Track the number of times this symbol is used

	constructor(
		readonly fileName: string,
		readonly node: ts.FunctionDeclaration | ts.ClassDeclaration | ts.EnumDeclaration | ts.VariableDeclaration,
		fileIdents: ShortIdent,
	) {
		// Placeholder for now - will be set later after counting references
		this.replacementName = '';
	}

	getLocations(service: ts.LanguageService): Iterable<{ fileName: string; offset: number }> {
		if (ts.isVariableDeclaration(this.node)) {
			// If the const aliases any types, we need to rename those too
			const definitionResult = service.getDefinitionAndBoundSpan(this.fileName, this.node.name.getStart());
			if (definitionResult?.definitions && definitionResult.definitions.length > 1) {
				return definitionResult.definitions.map(x => ({ fileName: x.fileName, offset: x.textSpan.start }));
			}
		}

		return [{
			fileName: this.fileName,
			offset: this.node.name!.getStart()
		}];
	}

	shouldMangle(newName: string): boolean {
		const currentName = this.node.name!.getText();
		if (currentName.startsWith('$') || skippedExportMangledSymbols.includes(currentName)) {
			return false;
		}

		// New name is longer the existing one :'(
		if (newName.length >= currentName.length) {
			return false;
		}

		// Don't mangle functions we've explicitly opted out
		if (this.node.getFullText().includes('@skipMangle')) {
			return false;
		}

		return true;
	}
}

export interface MangleOutput {
	out: string;
	sourceMap?: string;
}

/**
 * TypeScript2TypeScript transformer that mangles all private and protected fields
 *
 * 1. Collect all class fields (properties, methods)
 * 2. Collect all sub and super-type relations between classes
 * 3. Compute replacement names for each field
 * 4. Lookup rename locations for these fields
 * 5. Prepare and apply edits
 */
export class Mangler {

	private readonly allClassDataByKey = new Map<string, ClassData>();
	private readonly allExportedSymbols = new Set<DeclarationData>();
	private readonly symbolUsageCounts = new Map<string, number>(); // Map to store symbol usage counts

	private readonly renameWorkerPool: workerpool.WorkerPool;

	constructor(
		private readonly projectPath: string,
		private readonly log: typeof console.log = () => { },
		private readonly config: { readonly manglePrivateFields: boolean; readonly mangleExports: boolean },
	) {
		// Check for strict node_modules skip flag from environment
		const strictNodeModulesSkip = process.env.STRICT_NODE_MODULES_SKIP === 'true';
		if (strictNodeModulesSkip) {
			this.log('STRICT_NODE_MODULES_SKIP is enabled - will completely exclude all node_modules files completely');
		}

		this.renameWorkerPool = workerpool.pool(path.join(__dirname, 'renameWorker.js'), {
			maxWorkers: 4,
			minWorkers: 'max'
		});
	}

	private async countSymbolReferences(service: ts.LanguageService): Promise<void> {
		this.log('Counting symbol references for frequency-based naming');

		type FindRefFn = (projectName: string, fileName: string, pos: number) => ts.ReferencedSymbol[];

		// Process exports first
		const exportPromises: Array<Promise<void>> = [];

		for (const data of this.allExportedSymbols) {
			// Skip symbols we don't plan to mangle
			if (data.fileName.endsWith('.d.ts') ||
				skippedExportMangledProjects.some(proj => data.fileName.includes(proj)) ||
				skippedExportMangledFiles.some(file => data.fileName.endsWith(file + '.ts'))) {
				continue;
			}

			const currentName = data.node.name!.getText();
			if (currentName.startsWith('$') || skippedExportMangledSymbols.includes(currentName)) {
				continue;
			}

			// Skip functions with @skipMangle annotation
			if (data.node.getFullText().includes('@skipMangle')) {
				continue;
			}

			// Count references for the symbol
			for (const { fileName, offset } of data.getLocations(service)) {
				exportPromises.push(
					Promise.resolve(this.renameWorkerPool.exec<FindRefFn>('findReferences', [this.projectPath, fileName, offset]))
						.then(refs => {
							// Count all references as usage
							let count = 0;
							for (const ref of refs) {
								count += ref.references.length;
							}
							data.usageCount = Math.max(data.usageCount, count);
						})
				);
			}
		}

		// Wait for all reference counting to complete
		await Promise.all(exportPromises);

		// Process class members
		const classPromises: Array<Promise<void>> = [];

		for (const data of this.allClassDataByKey.values()) {
			if (hasModifier(data.node, ts.SyntaxKind.DeclareKeyword)) {
				continue;
			}

			for (const [name, info] of data.fields) {
				if (!ClassData._shouldMangle(info.type)) {
					continue;
				}

				// Count field references
				classPromises.push(
					Promise.resolve(this.renameWorkerPool.exec<FindRefFn>('findReferences', [this.projectPath, data.fileName, info.pos]))
						.then(refs => {
							// Store the usage count on the field itself
							let count = 0;
							for (const ref of refs) {
								count += ref.references.length;
							}

							// Store the count in a new property on data.fields
							(data.fields.get(name) as any).usageCount = count;
						})
				);
			}
		}

		await Promise.all(classPromises);

		this.log('Finished counting symbol references');
	}

	async computeNewFileContents(strictImplicitPublicHandling?: Set<string>): Promise<Map<string, MangleOutput>> {

		const service = ts.createLanguageService(new StaticLanguageServiceHost(this.projectPath));

		// STEP:
		// - Find all classes and their field info.
		// - Find exported symbols.

		const fileIdents = new ShortIdent('$');

		const visit = (node: ts.Node): void => {
			// Skip processing any files in node_modules, especially .d.ts files
			if (node.getSourceFile().fileName.includes('node_modules')) {
				return;
			}

			if (this.config.manglePrivateFields) {
				if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
					const anchor = node.name ?? node;
					const key = `${node.getSourceFile().fileName}|${anchor.getStart()}`;
					if (this.allClassDataByKey.has(key)) {
						throw new Error('DUPE?');
					}
					this.allClassDataByKey.set(key, new ClassData(node.getSourceFile().fileName, node));
				}
			}

			if (this.config.mangleExports) {
				// Find exported classes, functions, and vars
				if (
					(
						// Exported class
						ts.isClassDeclaration(node)
						&& hasModifier(node, ts.SyntaxKind.ExportKeyword)
						&& node.name
					) || (
						// Exported function
						ts.isFunctionDeclaration(node)
						&& ts.isSourceFile(node.parent)
						&& hasModifier(node, ts.SyntaxKind.ExportKeyword)
						&& node.name && node.body // On named function and not on the overload
					) || (
						// Exported variable
						ts.isVariableDeclaration(node)
						&& hasModifier(node.parent.parent, ts.SyntaxKind.ExportKeyword) // Variable statement is exported
						&& ts.isSourceFile(node.parent.parent.parent)
					)

					// Disabled for now because we need to figure out how to handle
					// enums that are used in monaco or extHost interfaces.
					/* || (
						// Exported enum
						ts.isEnumDeclaration(node)
						&& ts.isSourceFile(node.parent)
						&& hasModifier(node, ts.SyntaxKind.ExportKeyword)
						&& !hasModifier(node, ts.SyntaxKind.ConstKeyword) // Don't bother mangling const enums because these are inlined
						&& node.name
					*/
				) {
					if (isInAmbientContext(node)) {
						return;
					}

					this.allExportedSymbols.add(new DeclarationData(node.getSourceFile().fileName, node, fileIdents));
				}
			}

			ts.forEachChild(node, visit);
		};

		for (const file of service.getProgram()!.getSourceFiles()) {
			// Skip any files in node_modules or declaration files
			if (file.isDeclarationFile || NODE_MODULES_PATTERN.test(file.fileName)) {
				continue;
			}
			ts.forEachChild(file, visit);
		}
		this.log(`Done collecting all classes. Classes: ${this.allClassDataByKey.size}. Exported symbols: ${this.allExportedSymbols.size}`);


		//  STEP: connect sub and super-types

		const setupParents = (data: ClassData) => {
			const extendsClause = data.node.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
			if (!extendsClause) {
				// no EXTENDS-clause
				return;
			}

			const info = service.getDefinitionAtPosition(data.fileName, extendsClause.types[0].expression.getEnd());
			if (!info || info.length === 0) {
				// throw new Error('SUPER type not found');
				return;
			}

			if (info.length !== 1) {
				// inherits from declared/library type
				return;
			}

			const [definition] = info;
			const key = `${definition.fileName}|${definition.textSpan.start}`;
			const parent = this.allClassDataByKey.get(key);
			if (!parent) {
				// throw new Error(`SUPER type not found: ${key}`);
				return;
			}
			parent.addChild(data);
		};
		for (const data of this.allClassDataByKey.values()) {
			setupParents(data);
		}

		//  STEP: make implicit public (actually protected) field really public
		const violations = new Map<string, string[]>();
		let violationsCauseFailure = false;
		for (const data of this.allClassDataByKey.values()) {
			ClassData.makeImplicitPublicActuallyPublic(data, (name: string, what, why) => {
				const arr = violations.get(what);
				if (arr) {
					arr.push(why);
				} else {
					violations.set(what, [why]);
				}

				if (strictImplicitPublicHandling && !strictImplicitPublicHandling.has(name)) {
					violationsCauseFailure = true;
				}
			});
		}
		for (const [why, whys] of violations) {
			this.log(`WARN: ${why} became PUBLIC because of: ${whys.join(' , ')}`);
		}
		if (violationsCauseFailure) {
			const message = 'Protected fields have been made PUBLIC. This hurts minification and is therefore not allowed. Review the WARN messages further above';
			this.log(`ERROR: ${message}`);
			throw new Error(message);
		}

		// NEW STEP: Count symbol usages before generating replacement names
		await this.countSymbolReferences(service);

		// STEP: compute replacement names for each class
		// Instead of using the standard method, use the frequency-based approach
		this.assignIdentifiersByUsageFrequency();
		this.log(`Done creating class replacements based on usage frequency`);

		// STEP: prepare rename edits
		this.log(`Starting prepare rename edits`);

		type Edit = { newText: string; offset: number; length: number };
		const editsByFile = new Map<string, Edit[]>();

		const appendEdit = (fileName: string, edit: Edit) => {
			const edits = editsByFile.get(fileName);
			if (!edits) {
				editsByFile.set(fileName, [edit]);
			} else {
				edits.push(edit);
			}
		};
		const appendRename = (newText: string, loc: ts.RenameLocation) => {
			appendEdit(loc.fileName, {
				newText: (loc.prefixText || '') + newText + (loc.suffixText || ''),
				offset: loc.textSpan.start,
				length: loc.textSpan.length
			});
		};

		type RenameFn = (projectName: string, fileName: string, pos: number) => ts.RenameLocation[];

		const renameResults: Array<Promise<{ readonly newName: string; readonly locations: readonly ts.RenameLocation[] }>> = [];

		const queueRename = (fileName: string, pos: number, newName: string) => {
			renameResults.push(Promise.resolve(this.renameWorkerPool.exec<RenameFn>('findRenameLocations', [this.projectPath, fileName, pos]))
				.then((locations) => ({ newName, locations })));
		};

		for (const data of this.allClassDataByKey.values()) {
			if (hasModifier(data.node, ts.SyntaxKind.DeclareKeyword)) {
				continue;
			}

			fields: for (const [name, info] of data.fields) {
				if (!ClassData._shouldMangle(info.type)) {
					continue fields;
				}

				// TS-HACK: protected became public via 'some' child
				// and because of that we might need to ignore this now
				let parent = data.parent;
				while (parent) {
					if (parent.fields.get(name)?.type === FieldType.Public) {
						continue fields;
					}
					parent = parent.parent;
				}

				const newName = data.lookupShortName(name);
				queueRename(data.fileName, info.pos, newName);
			}
		}

		for (const data of this.allExportedSymbols.values()) {
			if (data.fileName.endsWith('.d.ts')
				|| skippedExportMangledProjects.some(proj => data.fileName.includes(proj))
				|| skippedExportMangledFiles.some(file => data.fileName.endsWith(file + '.ts'))
			) {
				continue;
			}

			if (!data.shouldMangle(data.replacementName)) {
				continue;
			}

			const newText = data.replacementName;
			for (const { fileName, offset } of data.getLocations(service)) {
				queueRename(fileName, offset, newText);
			}
		}

		await Promise.all(renameResults).then((result) => {
			for (const { newName, locations } of result) {
				// Filter out any locations that are in node_modules
				const filteredLocations = locations.filter(loc => !NODE_MODULES_PATTERN.test(loc.fileName));

				// If we filtered out some locations, log it
				if (filteredLocations.length !== locations.length) {
					this.log(`Skipped ${locations.length - filteredLocations.length} rename locations in node_modules`);
				}

				for (const loc of filteredLocations) {
					appendRename(newName, loc);
				}
			}
		});

		await this.renameWorkerPool.terminate();

		this.log(`Done preparing edits: ${editsByFile.size} files`);

		// STEP: apply all rename edits (per file)
		const result = new Map<string, MangleOutput>();
		let savedBytes = 0;

		for (const item of service.getProgram()!.getSourceFiles()) {

			const { mapRoot, sourceRoot } = service.getProgram()!.getCompilerOptions();
			const projectDir = path.dirname(this.projectPath);
			const sourceMapRoot = mapRoot ?? pathToFileURL(sourceRoot ?? projectDir).toString();

			// source maps
			let generator: SourceMapGenerator | undefined;

			let newFullText: string;
			const edits = editsByFile.get(item.fileName);
			if (!edits) {
				// just copy
				newFullText = item.getFullText();

			} else {
				// source map generator
				const relativeFileName = normalize(path.relative(projectDir, item.fileName));
				const mappingsByLine = new Map<number, Mapping[]>();

				// apply renames
				edits.sort((a, b) => b.offset - a.offset);
				const characters = item.getFullText().split('');

				let lastEdit: Edit | undefined;

				for (const edit of edits) {
					if (lastEdit && lastEdit.offset === edit.offset) {
						//
						if (lastEdit.length !== edit.length || lastEdit.newText !== edit.newText) {
							this.log('ERROR: Overlapping edit', item.fileName, edit.offset, edits);
							throw new Error('OVERLAPPING edit');
						} else {
							continue;
						}
					}
					lastEdit = edit;
					const mangledName = characters.splice(edit.offset, edit.length, edit.newText).join('');
					const line = item.getSourceFile().getLineAndCharacterOfPosition(edit.offset);
					const mapping: Mapping = {
						source: relativeFileName,
						generated: { line: line.line + 1, column: line.character },
						original: { line: line.line + 1, column: line.character },
					};

					if (!mappingsByLine.has(line.line)) {
						mappingsByLine.set(line.line, []);
					}
					mappingsByLine.get(line.line)!.push(mapping);
				}

				// generate source map
				generator = new SourceMapGenerator({
					file: path.basename(item.fileName),
					sourceRoot: sourceMapRoot,
				});
				for (const [line, mappings] of mappingsByLine) {
					for (const mapping of mappings) {
						generator.addMapping(mapping);
					}
				}

				// NOTE: this might not be necessary anymore with the latest source-map package
				generator._file = path.basename(item.fileName);
				generator._sourceRoot = sourceMapRoot;

				newFullText = characters.join('');
			}

			// strip BOM
			if (newFullText.startsWith('\uFEFF')) {
				newFullText = newFullText.slice(1);
			}

			result.set(item.fileName, {
				out: newFullText,
				sourceMap: generator ? generator.toString() : undefined
			});

			// update file content
			// await fs.promises.writeFile(item.fileName, newFullText);
		}

		return result;
	}

	private assignIdentifiersByUsageFrequency() {
		this.log('Assigning short identifiers based on usage frequency');

		// For exported symbols
		const exportedArray = Array.from(this.allExportedSymbols);
		// Sort by usage count in descending order (most used first)
		exportedArray.sort((a, b) => b.usageCount - a.usageCount);

		// Assign short identifiers to exports in order of usage frequency
		const exportIdents = new ShortIdent('$');
		for (const data of exportedArray) {
			// Skip symbols that won't be mangled
			if (data.fileName.endsWith('.d.ts') ||
				skippedExportMangledProjects.some(proj => data.fileName.includes(proj)) ||
				skippedExportMangledFiles.some(file => data.fileName.endsWith(file + '.ts'))) {
				continue;
			}

			const currentName = data.node.name!.getText();
			if (currentName.startsWith('$') || skippedExportMangledSymbols.includes(currentName)) {
				continue;
			}

			if (data.node.getFullText().includes('@skipMangle')) {
				continue;
			}

			// Assign the next available short identifier
			const newName = exportIdents.next(name => isNameTakenInFile(data.node, name));
			// Only set it if it's shorter than original
			if (newName.length < currentName.length) {
				(data as any).replacementName = newName;
				this.log(`Assigning ${newName} to ${currentName} (used ${data.usageCount} times)`);
			}
		}

		// For class fields/methods, modify the ClassData.fillInReplacement method to use usage counts
		this.log('Finished assigning identifiers based on usage frequency');
	}
}

async function _run() {

	const projectBase = path.resolve(argv[2]);
	const newProjectBase = path.resolve(argv[3]);

	const mangler = new Mangler(projectBase, console.log, {
		manglePrivateFields: true,
	});
	for (const [fileName, contents] of await mangler.computeNewFileContents(new Set(['saveState']))) {
		const newFilePath = path.join(newProjectBase, path.relative(projectBase, fileName));
		await fs.promises.mkdir(path.dirname(newFilePath), { recursive: true });
		await fs.promises.writeFile(newFilePath, contents.out);
		if (contents.sourceMap) {
			await fs.promises.writeFile(newFilePath + '.map', contents.sourceMap);
		}
	}
}

if (__filename === argv[1]) {
	_run();
}
