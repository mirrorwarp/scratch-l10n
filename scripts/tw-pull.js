#!/usr/bin/env babel-node

import pathUtil from 'node:path';
import fs from 'node:fs';
import {txPull} from '../lib/transifex';
import {supportedLocales, localeMap} from './tw-locales';
import {batchMap} from '../lib/batch.js';

const PROJECT = 'turbowarp';
const CONCURRENCY_LIMIT = 36;
const SOURCE_LOCALE = 'en';

/* eslint-disable valid-jsdoc */

/**
 * Not sure how to do this in JSDoc
 * @template T
 * @typedef {Record<string, T>} NestedRecord<T>
 */

/**
 * Normalizes messages in the following ways by converting objects with context to just strings,
 * and ensures that the order of keys is consistent.
 * @param {NestedRecord<string | {string: string}>} messages
 * @returns {NestedRecord<string>}
 */
const normalizeMessages = messages => {
    const result = {};
    for (const id of Object.keys(messages).sort()) {
        const string = messages[id];
        if (typeof string === 'string') {
            // Don't touch normal strings.
            result[id] = string;
        } else if (typeof string.string === 'string') {
            // Convert structured strings with context to normal strings.
            result[id] = string.string;
        } else {
            // Recurse into nested message objects.
            result[id] = normalizeMessages(string);
        }
    }
    return result;
};

/**
 * @param {NestedRecord<string>} localeMessages
 * @param {NestedRecord<string>} sourceMessages
 * @returns {NestedRecord<string>}
 */
const removeRedundantMessages = (localeMessages, sourceMessages) => {
    const result = {};
    for (const [messageId, messageContent] of Object.entries(localeMessages)) {
        const string = messageContent;
        const sourceString = sourceMessages[messageId];
        if (typeof string === 'string') {
            // Copy strings that do not exactly match their English counterpart.
            if (string !== sourceString) {
                result[messageId] = string;
            }
        } else {
            // Recurse into nested objects.
            const nested = removeRedundantMessages(string, sourceString);
            if (Object.keys(nested).length !== 0) {
                result[messageId] = nested;
            }
        }
    }
    return result;
};

/**
 * @param {NestedRecord<string>} messages
 * @returns {number}
 */
const countStrings = messages => {
    let count = 0;
    for (const string of Object.values(messages)) {
        if (typeof string === 'string') {
            count += 1;
        } else {
            count += countStrings(string);
        }
    }
    return count;
};

/**
 * @param {string} resource Name of Transifex resource
 * @param {number} requiredCompletion Number from 0-1 indicating what % of messages must be translated.
 *  Locales that do not meet this threshold are removed.
 * @returns {Promise<Record<string, Record<string, string>>}
 */
const pullResource = async (resource, requiredCompletion) => {
    const values = await batchMap(Object.keys(supportedLocales), CONCURRENCY_LIMIT, async locale => {
        try {
            const messages = await txPull(PROJECT, resource, localeMap[locale] || locale);
            console.log(`Pulled ${locale} for ${resource}`);
            return {
                locale,
                messages: normalizeMessages(messages)
            };
        } catch (error) {
            // Transifex's error messages sometimes lack enough detail, so we will include
            // some extra information.
            console.error(`Could not fetch messages for locale: ${locale}`);
            throw error;
        }
    });

    const sourceMessages = values.find(i => i.locale === SOURCE_LOCALE).messages;
    const threshold = Math.max(1, countStrings(sourceMessages) * requiredCompletion);

    const result = {};
    for (const pulled of values) {
        const slimmedMessages = removeRedundantMessages(pulled.messages, sourceMessages);
        if (countStrings(slimmedMessages) >= threshold) {
            result[pulled.locale.toLowerCase()] = slimmedMessages;
        }
    }

    return result;
};

const isDirectorySync = path => {
    try {
        const stat = fs.statSync(path);
        return stat.isDirectory();
    } catch (e) {
        if (e.code === 'ENOENT') {
            return false;
        }
        throw e;
    }
};

const pullGui = async () => {
    const scratchGui = pathUtil.join(__dirname, '../../scratch-gui');
    if (!isDirectorySync(scratchGui)) {
        console.log('Skipping editor; could not find scratch-gui.');
        return;
    }

    const guiTranslationsFile = pathUtil.join(scratchGui, 'src/lib/tw-translations/generated-translations.json');
    // These translations build upon scratch-l10n, so the threshold should be 0.
    const guiTranslations = await pullResource('guijson', 0);
    fs.writeFileSync(guiTranslationsFile, JSON.stringify(guiTranslations, null, 4));

    const addonsTranslationsFile = pathUtil.join(scratchGui, 'src/addons/settings/translations.json');
    const addonsTranslations = await pullResource('addonsjson', 0.5);
    fs.writeFileSync(addonsTranslationsFile, JSON.stringify(addonsTranslations, null, 4));
};

const pullPackager = async () => {
    const packager = pathUtil.join(__dirname, '../../packager');
    if (!isDirectorySync(packager)) {
        console.log('Skipping packager; could not find packager.');
        return;
    }

    const translations = await pullResource('packagerjson', 0.5);

    // Write the individual JSON files
    const localesDirectory = pathUtil.join(packager, 'src', 'locales');
    for (const [locale, messages] of Object.entries(translations)) {
        const path = pathUtil.join(localesDirectory, `${locale}.json`);
        fs.writeFileSync(path, JSON.stringify(messages, null, 4));
    }

    // Write the index.js manifest
    const index = pathUtil.join(localesDirectory, 'index.js');
    const oldContent = fs.readFileSync(index, 'utf-8');
    const newContent = oldContent.replace(/\/\*===\*\/[\s\S]+\/\*===\*\//m, `/*===*/\n${
        Object.keys(translations)
            .map(i => `  ${JSON.stringify(i)}: () => require(${JSON.stringify(`./${i}.json`)})`)
            .join(',\n')
    },\n  /*===*/`);
    fs.writeFileSync(index, newContent);

    // Write locale-names.json
    // TODO: We should make packager just import this from scratch-l10n
    const localeNames = {};
    for (const [locale, {name}] of Object.entries(supportedLocales)) {
        localeNames[locale] = name;
    }
    fs.writeFileSync(pathUtil.join(localesDirectory, 'locale-names.json'), JSON.stringify(localeNames, null, 4));
};

const pullDesktop = async () => {
    const desktop = pathUtil.join(__dirname, '../../turbowarp-desktop');
    if (!isDirectorySync(desktop)) {
        console.log('Skipping desktop; could not find turbowarp-desktop.');
        return;
    }

    const desktopTranslations = await pullResource('desktopjson', 0.5);
    fs.writeFileSync(
        pathUtil.join(desktop, 'src/l10n/translations.json'),
        JSON.stringify(desktopTranslations, null, 4)
    );

    const semiPrettyPrint = (json) => {
        let result = '{\n';
        for (const key of Object.keys(json)) {
            result += `${JSON.stringify(key)}:${JSON.stringify(json[key])},\n`;
        }
        result += '}';
        return result;
    };

    const webTranslations = await pullResource('desktop-webjson', 0.5);
    const indexHtml = pathUtil.join(desktop, 'docs', 'index.html');
    const oldContent = fs.readFileSync(indexHtml, 'utf-8');
    const newContent = oldContent.replace(
        /\/\*===\*\/[\s\S]+\/\*===\*\//m,
        `/*===*/${semiPrettyPrint(webTranslations)}/*===*/`
    );
    fs.writeFileSync(indexHtml, newContent);

    // TODO: pull store-listingsyaml
};

const pullEverything = async () => {
    try {
        console.log('DOWNLOADING from Transifex...');
        await pullGui();
        await pullPackager();
        await pullDesktop();
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

pullEverything();
