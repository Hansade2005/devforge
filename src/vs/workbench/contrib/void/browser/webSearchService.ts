/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';

export interface IWebSearchService {
    readonly _serviceBrand: undefined;
    search(query: string): Promise<string>;
}

export const IWebSearchService = createDecorator<IWebSearchService>('webSearchService');

const searchApiKey = "AIzaSyCPR3fFs89C3KoUqlfQ3D7fuY_qE6QMtq8";
const searchEngineId = "b5c87db0a2743426b";

class WebSearchService implements IWebSearchService {
    readonly _serviceBrand: undefined;

    async search(query: string): Promise<string> {
        try {
            // First get URLs from Google Custom Search API
            const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${searchApiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}`;
            const searchResponse = await fetch(searchUrl);
            const searchData = await searchResponse.json();

            if (!searchData.items || searchData.items.length === 0) {
                return "No results found.";
            }

            // Get top 10 URLs
            const urls = searchData.items.slice(0, 10).map((item: any) => item.link);

            // Launch puppeteer
            const browser = await puppeteer.launch({ headless: "new" });
            const contexts: string[] = [];

            // Visit each URL and extract content
            for (const url of urls) {
                try {
                    const page = await browser.newPage();
                    await page.goto(url, { waitUntil: 'networkidle0', timeout: 10000 });
                    const html = await page.content();

                    // Use cheerio to parse content
                    const $ = cheerio.load(html);
                    // Remove scripts, styles, and other non-content elements
                    $('script').remove();
                    $('style').remove();
                    $('nav').remove();
                    $('header').remove();
                    $('footer').remove();

                    // Get main content
                    const text = $('body').text()
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 1000); // Limit context per page

                    contexts.push(`Source: ${url}\n${text}\n---\n`);
                    await page.close();
                } catch (error) {
                    console.error(`Error processing ${url}:`, error);
                }
            }

            await browser.close();
            return contexts.join('\n');

        } catch (error) {
            console.error('Web search error:', error);
            return `Error performing web search: ${error.message}`;
        }
    }
}

registerSingleton(IWebSearchService, WebSearchService, true);
