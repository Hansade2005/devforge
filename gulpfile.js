/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gulp = require('gulp');
const del = require('del');

function clean() {
	return del(['.build']); // Replace '.build' with your build output directory if it's different
}

gulp.task('clean', clean);
require('./build/gulpfile');
const _compileTask = require('./build/gulpfile')._compileTask;
gulp.task('default', gulp.series('clean', _compileTask));
