#!/usr/bin/env babel-node

import fs from 'node:fs';
import pathUtil from 'node:path';
import {txPush} from '../lib/transifex.js';

/* eslint-disable valid-jsdoc */

/**
 * @param {string} path
 * @returns {boolean}
 */
const isDirectorySync = (path) => {
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

/**
 * @param {string} directory
 * @returns {string[]}
 */
const recursiveReadDirectory = (directory) => {
    const children = fs.readdirSync(directory);
    const result = [];
    for (const name of children) {
        const path = pathUtil.join(directory, name);
        if (isDirectorySync(path)) {
            const directoryChildren = recursiveReadDirectory(path);
            for (const childName of directoryChildren) {
                result.push(pathUtil.join(name, childName));
            }
        } else {
            result.push(name);
        }
    }
    return result;
};

const scratchGui = pathUtil.join(__dirname, '..', '..', 'scratch-gui');
const scratchGuiTranslations = pathUtil.join(scratchGui, 'translations');
const scratchVm = pathUtil.join(__dirname, '..', '..', 'scratch-vm');
if (!isDirectorySync(scratchGui)) throw new Error('Cannot find scratch-gui');
if (!isDirectorySync(scratchGuiTranslations)) throw new Error('Cannot find scratch-gui translations');
if (!isDirectorySync(scratchVm)) throw new Error('Cannot find scratch-vm');

/**
 * @typedef StructuredMessage
 * @property {string} string
 * @property {string} context
 * @property {string} developer_comment
 */

/**
 * @param {string} sourceString
 * @param {string} description
 * @returns {StructuredMessage}
 */
const makeStructuredMessage = (sourceString, description) => ({
    string: sourceString,
    // We set context because that's what we used to use in the past and removing it now would reset translations
    // However, we also set developer_comment because Transifex makes this string much more visible in the
    // interface than the context.
    context: description,
    developer_comment: description
});

/**
 * @returns {{messages: Record<string, StructuredMessage>, allUsedIds: string[]}}
 */
const parseSourceGuiMessages = () => {
    const reactTranslationFiles = recursiveReadDirectory(scratchGuiTranslations)
        .filter((file) => file.endsWith('.json'));

    const messages = {};
    const allUsedIds = [];
    for (const file of reactTranslationFiles) {
        const path = pathUtil.join(scratchGuiTranslations, file);
        const json = JSON.parse(fs.readFileSync(path, 'utf-8'));
        for (const {id, defaultMessage, description} of json) {
            allUsedIds.push(id);
            if (id.startsWith('tw.')) {
                messages[id] = makeStructuredMessage(defaultMessage, description);
            }
        }
    }

    allUsedIds.sort();

    return {
        messages,
        allUsedIds
    };
};

/**
 * @returns {Record<string, StructuredMessage>}
 */
const parseSourceVmMessages = () => {
    // Parse all calls to formatMessage()
    const messages = {};
    const contents = fs.readFileSync(pathUtil.join(scratchVm, 'src', 'extensions', 'tw', 'index.js'), 'utf-8');
    for (const formatMatch of contents.matchAll(/formatMessage\({([\s\S]+?)}/g)) {
        const object = {};
        for (const lineMatch of formatMatch[1].matchAll(/(\w+): (?:'|")(.*)(?:'|")/g)) {
            const [_, id, value] = lineMatch;
            object[id] = value;
        }
        if (
            typeof object.id !== 'string' ||
            typeof object.default !== 'string' ||
            typeof object.description !== 'string'
        ) {
            throw new Error('Error parsing formatMessage() string.');
        }
        messages[object.id] = makeStructuredMessage(object.default, object.description);
    }
    return messages;
};

const hardcodedMessages = {
    'tw.blocks.openDocs': makeStructuredMessage('Open Documentation', 'Button that opens extension documentation')
};
const {messages: guiMessages, allUsedIds} = parseSourceGuiMessages();
const vmMessages = parseSourceVmMessages();
const sourceMessages = {
    ...hardcodedMessages,
    ...guiMessages,
    ...vmMessages
};

fs.writeFileSync(pathUtil.join(__dirname, 'tw-all-used-ids.json'), JSON.stringify(allUsedIds, null, 4));

const push = async () => {
    try {
        console.log('UPLOADING to Transifex...');
        const PROJECT = 'turbowarp';
        const RESOURCE = 'guijson';
        await txPush(PROJECT, RESOURCE, sourceMessages);
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
};

push();
