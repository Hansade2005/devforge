/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import { ISharedWebContentExtractorService } from '../common/webContentExtractor.js';

export class SharedWebContentExtractorService implements ISharedWebContentExtractorService {
	_serviceBrand: undefined;

	async extract(options: { uri: URI }, token: CancellationToken): Promise<{ content: string } | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		try {
			const response = await fetch(options.uri.toString(true));
			if (!response.ok) {
				return undefined;
			}

			const content = await response.text();
			return { content };
		} catch (err) {
			console.log(err);
			return undefined;
		}
	}

	async readImage(uri: URI, token: CancellationToken): Promise<VSBuffer | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		try {
			const response = await fetch(uri.toString(true), {
				headers: {
					'Accept': 'image/*',
					'User-Agent': 'Mozilla/5.0'
				}
			});
			const contentType = response.headers.get('content-type');
			if (!response.ok || !contentType?.startsWith('image/') || !/(webp|jpg|jpeg|gif|png|bmp)$/i.test(contentType)) {
				return undefined;
			}

			const content = VSBuffer.wrap(await response.bytes());
			return content;
		} catch (err) {
			console.log(err);
			return undefined;
		}
	}
}
