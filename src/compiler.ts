import * as childProcess from 'child_process';
import * as path from 'path';
import { loader } from 'webpack';

import { LoaderOption } from './option';
import * as utility from './utility';
import * as message from './message';

/**
 * Compiling Processor.
 */
export class Compiler {
	/**
	 * Process list file.
	 */
	async process(context : loader.LoaderContext, content : string, options : LoaderOption) {
		context.clearDependencies();
		context.addDependency(context.resourcePath);
		
		let error = false;
		const objs = [];
		for (const line of content.split(/\n|\n?\r/gm).map(str => str.trim())) {
			if (line.length <= 0 || line.startsWith('#')) {
				continue;
			}
			
			if (line.startsWith('^')) {
				const preJs = path.resolve(context.context, line.slice(1));
				context.addDependency(preJs);
				options.preJs = preJs;
				continue;
			}
			
			if (line.startsWith('$')) {
				const postJs = path.resolve(context.context, line.slice(1));
				context.addDependency(postJs);
				options.preJs = postJs;
				continue;
			}
			
			const absPath = path.resolve(context.context, line);
			
			if (absPath.match(/\.(a|bc|o)/i)) {
				context.addDependency(absPath);
				objs.push(absPath);
				continue;
			}
			
			const outputFileName = `${utility.getTempName(absPath)}.bc`;
			const outputPath = path.join(options.buildDir, outputFileName);
			const messages = await this.compile(context, outputPath, absPath, options);
			message.emitCompileMessages(context, messages);
			error = error || message.containsError(messages);
			objs.push(outputPath);
		}
		
		const absPath = context.resourcePath;
		const basename = path.basename(absPath, path.extname(absPath));
		const baseScriptPath = path.join(options.buildDir, `${basename}.js`);
		
		if (!error) {
			const messages = await this.link(context, baseScriptPath, objs, options);
			message.emitCompileMessages(context, messages);
			error = message.containsError(messages);
		}
		
		if (error) {
			throw new Error('Encountered error while compiling.');
		}
		
		await this.emitFiles(context, options.buildDir);
		return this.buildLoaderScript(await utility.readFile(baseScriptPath, 'utf-8'), options);
	}
	
	/**
	 * Compiles C/C++ file.
	 */
	async compile(context : loader.LoaderContext, outputPath : string, srcPath : string, options : LoaderOption) {
		const extension = path.extname(srcPath);
		
		const cpp = extension.match(/\.c(c|pp|xx)$/i) !== null;
		const compiler = cpp ? options.cxx : options.cc;
		const xxFlags = cpp ? options.cxxFlags : options.cFlags;
		const flags = [...options.commonFlags, ...xxFlags];
		
		const dependencies = await utility.getDependencies(compiler, srcPath, flags);
		utility.addDependencies(context, dependencies);
		const latestModifiedTime = await utility.getLatestModifiedTime(dependencies);
		const bcModifiedTime = await utility.getModifiedTime(outputPath);
		
		if (latestModifiedTime < bcModifiedTime) {
			return [];
		}
		
		await utility.mkdirs(path.dirname(outputPath));
		const { stderr } = await utility.execute(compiler, [...flags, '-o', outputPath, srcPath]).catch(err => {
			return { stderr: err.stderr as string | Buffer };
		});
		return message.parseClangMessage(stderr.toString());
	}
	
	/**
	 * Links object files.
	 */
	async link(context : loader.LoaderContext, outputPath : string, objs : string[], options : LoaderOption) {
		const flags = [...options.commonFlags, ...options.ldFlags, '-s', 'WASM=1', '-o', outputPath, ...objs];
		options.preJs && flags.unshift('--pre-js', options.preJs);
		options.postJs && flags.unshift('--post-js', options.postJs);
		await utility.mkdirs(path.dirname(outputPath));
		const { stderr } = await utility.execute(options.ld, flags).catch(err => {
			return { stderr: err.stderr as string | Buffer };
		});
		return message.parseClangMessage(stderr.toString());
	}
	
	/**
	 * Emits all files.
	 */
	async emitFiles(context : loader.LoaderContext, buildDir : string) {
		const absPath = context.resourcePath;
		const basename = path.basename(absPath, path.extname(absPath));
		[
			`${basename}.asm.js`,
			`${basename}.js.mem`,
			`${basename}.wast`,
			`${basename}.wasm`,
			`${basename}.wasm.map`,
		].forEach(name => this.emitIfExists(context, buildDir, name));
	}
	
	/**
	 * Emits a specified file.
	 */
	async emitIfExists(context : loader.LoaderContext, buildDir : string, fileName : string) {
		const absPath = path.join(buildDir, fileName);
		if (utility.exists(absPath)) {
			context.emitFile(fileName, await utility.readFile(absPath), null);
		}
	}
	
	/**
	 * Builds a loader script.
	 */
	async buildLoaderScript(baseScriptContent : string, options : LoaderOption) {
		const config = {
			ENVIRONMENT: options.environment,
		};
		
		return `
			module.exports = (function(config) {
				return {
					initialize: function (userModule) {
						userModule = userModule || {};
						return new Promise((resolve, reject) => {
							var Module = Object.assign({}, userModule, config);
							Module['onRuntimeInitialized'] = () => resolve(Module);

${baseScriptContent}

						});
					}
				};
			})(${JSON.stringify(config)});`;
	}
}