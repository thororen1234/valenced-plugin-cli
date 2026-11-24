import { describe, expect, test } from 'bun:test'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rolldown } from 'rolldown'
import { fileParserPlugin, inlineExternalImports, run } from '../src/build.ts'

/** Emits the rewritten module, or the input when nothing was rewritten. */
function transform(code: string): string {
	return inlineExternalImports(code, '/plugin/index.tsx') ?? code
}

describe('CLI Build Global Mapping & AST Transformer', () => {
	test('maps imports to the global named by the import map', () => {
		expect(
			transform(
				"import { Design } from '@valenced/discord/design'\nexport default Design\n",
			),
		).toContain('valenced.discord.design.Design')

		// The path is not derived from the module path. `browserify` is `Browserify`.
		expect(
			transform(
				"import { Browserify } from '@valenced/externals/browserify'\nexport default Browserify\n",
			),
		).toContain('valenced.externals.Browserify.Browserify')

		// A hidden module lives under `valenced.hidden`, not under its own namespace.
		expect(
			transform(
				"import { pList } from '@valenced/plugins/_'\nexport default pList\n",
			),
		).toContain('valenced.hidden.plugins.internal.pList')
	})

	test('reads the default export directly when the map says interop is default', () => {
		// The global IS the default export, so no `.default` is appended.
		expect(
			transform(
				"import Page from '@valenced/components/Page'\nexport default Page\n",
			).trim(),
		).toBe('export default valenced.components.Page')

		// The global is a namespace, so a default import must read `.default`.
		expect(
			transform(
				"import patcher from '@valenced/patcher'\nexport default patcher\n",
			).trim(),
		).toBe('export default valenced.patcher.default')
	})

	test('refuses to read a namespace or a name off a default-interop global', () => {
		expect(() =>
			transform("import * as P from '@valenced/components/Page'\nP\n"),
		).toThrow(/has no namespace/)

		expect(() =>
			transform("import { Foo } from '@valenced/components/Page'\nFoo\n"),
		).toThrow(/not readable at runtime/)
	})

	test('erases an import of a types-only module', () => {
		// `@valenced/*/types` modules hold no global. TypeScript erases an import of one that is
		// used in type positions only, so the CLI must accept it with or without the `type` keyword
		// and emit the same code.
		const withKeyword = transform(
			"import type { PluginApi } from '@valenced/plugins/types'\nimport { after } from '@valenced/patcher'\nexport default (api: PluginApi) => after(api, 'x', () => {})\n",
		)

		const withoutKeyword = transform(
			"import { PluginApi } from '@valenced/plugins/types'\nimport { after } from '@valenced/patcher'\nexport default (api: PluginApi) => after(api, 'x', () => {})\n",
		)

		expect(withKeyword.trim()).toBe(
			"export default (api: PluginApi) => valenced.patcher.after(api, 'x', () => {})",
		)
		expect(withoutKeyword).toBe(withKeyword)
	})

	test('maps a bare host package as CommonJS', () => {
		// The default import is the module object itself, not its `.default`.
		expect(
			transform(
				"import React, { useState } from 'react'\nexport default [React, useState]\n",
			).trim(),
		).toBe('export default [valenced.react.React, valenced.react.React.useState]')
	})

	test('inlines destructured symbols from imported objects and erases destructuring statements', () => {
		const output = transform(`
import { Design } from '@valenced/discord/design'

const {
	Stack,
	Text,
} = Design

export default function SettingsComponent() {
	return <Text><Stack /></Text>
}
`)

		expect(output).not.toContain('} = Design')
		expect(output).toContain('<valenced.discord.design.Design.Text>')
		expect(output).toContain('<valenced.discord.design.Design.Stack />')
	})

	test('erases a destructuring statement instead of leaving a fragment of it', () => {
		// The declaration is removed as a whole, and the identifier inside it is
		// rewritten to a long `valenced.*` path. Both edits cover the same text, so
		// applying both leaves the tail of the rewritten path behind as a statement
		// that reads an undeclared global.
		const code = `import { withDependencies } from '@valenced/modules/finders/filters'

const { atLeast } = withDependencies

export default plugin({
	preInit() {
		withDependencies(atLeast(64, []))
	},
})
`
		expect(inlineExternalImports(code, '/plugin/index.ts')).toBe(`



export default plugin({
	preInit() {
		valenced.modules.finders.filters.withDependencies(valenced.modules.finders.filters.withDependencies.atLeast(64, []))
	},
})
`)
	})

	test('erases nested destructuring chains without leaving a fragment', () => {
		const code = `import { Design } from '@valenced/discord/design'

const { Stack, Text } = Design
const { Provider } = Stack

export default plugin({
	start() {
		return [Stack, Text, Provider]
	},
})
`
		expect(inlineExternalImports(code, '/plugin/index.ts')).toBe(`




export default plugin({
	start() {
		return [valenced.discord.design.Design.Stack, valenced.discord.design.Design.Text, valenced.discord.design.Design.Stack.Provider]
	},
})
`)
	})

	test('rewrites a destructuring statement that is only partly import derived', () => {
		// `other` is not import derived, so the statement must survive, but the
		// import derived initializer inside it still needs rewriting.
		const code = `import { Design } from '@valenced/discord/design'

const { Stack } = Design, other = compute()

export default plugin({ start() { return [Stack, other] } })
`
		expect(inlineExternalImports(code, '/plugin/index.ts')).toBe(`

const { Stack } = valenced.discord.design.Design, other = compute()

export default plugin({ start() { return [valenced.discord.design.Design.Stack, other] } })
`)
	})
})

describe('CLI Build File Parser', () => {
	test('bundles a JSON import as a default export object', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'valenced-cli-json-'))
		writeFileSync(join(dir, 'data.json'), '{\r\n\t"id": "a.b"\r\n}\r\n')
		writeFileSync(
			join(dir, 'index.js'),
			"import data from './data.json' with { type: 'json' }\nexport const id = data.id\n",
		)
		const bundle = await rolldown({
			input: join(dir, 'index.js'),
			plugins: [fileParserPlugin],
		})
		const { output } = await bundle.generate({ format: 'esm' })
		expect(output[0].code).toContain('"a.b"')
	})
})

describe('CLI Build Phoenix', () => {
	test('maps @valenced/phoenix modules to valenced.phoenix', () => {
		const output = inlineExternalImports(
			"import { on } from '@valenced/phoenix/gateway'\nimport { onOps } from '@valenced/phoenix'\nimport { splitDispatch } from '@valenced/phoenix/ui'\nimport { ByteReader } from '@valenced/phoenix/bytes'\nexport default [on, onOps, splitDispatch, ByteReader]\n",
			'/plugin/phoenix.ts',
			true,
		)
		expect(output?.trim()).toBe(
			'export default [valenced.phoenix.on, valenced.phoenix.onOps, valenced.phoenix.ui.splitDispatch, valenced.phoenix.bytes.ByteReader]',
		)
	})

	test('rejects React Native modules in a Phoenix bundle', () => {
		expect(() =>
			inlineExternalImports(
				"import { useState } from 'react'\nuseState()\n",
				'/plugin/phoenix.ts',
				true,
			),
		).toThrow(/react is not available in Phoenix/)

		expect(() =>
			inlineExternalImports(
				"import { Design } from '@valenced/discord/design'\nDesign()\n",
				'/plugin/phoenix.ts',
				true,
			),
		).toThrow(/not available in Phoenix/)
	})

	test('rejects @valenced/phoenix outside a Phoenix bundle', () => {
		expect(() =>
			transform("import { on } from '@valenced/phoenix/gateway'\non()\n"),
		).toThrow(/only available in a Phoenix bundle/)
	})

	test('builds phoenix.ts into build/phoenix/index.js', async () => {
		const root = mkdtempSync(join(tmpdir(), 'valenced-cli-phoenix-'))
		const plugin = (
			name: string,
			dist: Record<string, string>,
			files: Record<string, string>,
		) => {
			mkdirSync(join(root, name, 'js'), { recursive: true })
			writeFileSync(
				join(root, name, 'manifest.json'),
				JSON.stringify({ id: `a.${name}`, dist }),
			)
			for (const [file, code] of Object.entries(files))
				writeFileSync(join(root, name, file), code)
		}

		plugin(
			'both',
			{ script: 'index.js', phoenix: 'phoenix.js' },
			{
				'js/index.ts': 'export default plugin({ start() {} })\n',
				'js/phoenix.ts':
					"import { on } from '@valenced/phoenix/gateway'\nexport default plugin({ start() { on('MESSAGE_CREATE', () => {}) } })\n",
			},
		)
		plugin(
			'rn-only',
			{ script: 'index.js' },
			{
				'js/index.ts': 'export default plugin({})\n',
				'js/phoenix.ts': 'export default plugin({})\n',
			},
		)
		plugin(
			'prebuilt',
			{ phoenix: 'phoenix.js' },
			{ 'phoenix.js': '({ default: plugin({}) })\n' },
		)

		await run(['--plugins-dir', root])

		expect(process.exitCode).toBeFalsy()
		expect(existsSync(join(root, 'both', 'build', 'js', 'index.js'))).toBe(true)
		expect(
			readFileSync(join(root, 'both', 'build', 'phoenix', 'index.js'), 'utf8'),
		).toContain('valenced.phoenix.on(')
		expect(existsSync(join(root, 'rn-only', 'build', 'phoenix'))).toBe(false)
		expect(existsSync(join(root, 'prebuilt', 'build'))).toBe(false)
	})

	test('fails a Phoenix build that imports React', async () => {
		const root = mkdtempSync(join(tmpdir(), 'valenced-cli-phoenix-'))
		mkdirSync(join(root, 'p'))
		writeFileSync(
			join(root, 'p', 'manifest.json'),
			JSON.stringify({ id: 'a.p', dist: { phoenix: 'phoenix.js' } }),
		)
		writeFileSync(
			join(root, 'p', 'phoenix.ts'),
			"import { useState } from 'react'\nexport default plugin({ start() { useState() } })\n",
		)

		await run(['--plugins-dir', root])

		expect(process.exitCode).toBe(1)
		expect(existsSync(join(root, 'p', 'build'))).toBe(false)
		process.exitCode = 0
	})
})
