/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2019 Center for History and New Media
					George Mason University, Fairfax, Virginia, USA
					http://zotero.org
	
	This file is part of Zotero.
	
	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.	See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero.	If not, see <http://www.gnu.org/licenses/>.
	
	***** END LICENSE BLOCK *****
*/

// Zotero.Prefs.set('cite.useCiteprocRs', true);

Zotero.CiteprocRs = {
	init: async function () {
		Zotero.debug("require('citeproc_rs_wasm_include')");
		const { CiteprocRsError } = require('citeproc_rs_wasm_include')
		Zotero.debug("require('citeproc_rs_wasm')");
		let init = require('citeproc_rs_wasm');
		// Initialize the wasm code
		Zotero.debug("Loading citeproc-rs wasm binary");
		const xhr = await Zotero.HTTP.request('GET', 'resource://zotero/citeproc_rs_wasm_bg.wasm', {
			responseType: "arraybuffer"
		});
		Zotero.debug("Initializing the CiteprocRs wasm driver");
		await init(Promise.resolve(xhr.response));
		Zotero.debug("CiteprocRs driver initialized successfully");
	},
	
	Engine: class {
		constructor(system, style, styleXML, locale, overrideLocale) {
			this._styleXML = styleXML;
			this._overrideLocale = overrideLocale;
			
			this.locale = locale;

			this._format = 'rtf';
			this._resetDriver();

			this.styleID = style.styleID;
			this.hasBibliography = style._hasBibliography;
			this.sys = system;
			this.opt = { sort_citations: true };
		}
		
		_resetDriver() {
			if (Zotero.CiteprocRs.Driver == null) {
				Zotero.debug('CiteprocRs: Driver not ready yet', 5);
				return;
			}
			if (this._driver) {
				Zotero.debug('CiteprocRs: free Driver', 5);
				this._driver.free();
			}
			Zotero.debug('CiteprocRs: new Driver', 5);
			this._driver = Zotero.CiteprocRs.Driver.new({
				style: this._styleXML,
				format: this._format,
				fetcher: {
					fetchLocale: this._fetchLocale.bind(this),
				},
				localeOverride: this._overrideLocale ? this.locale : undefined,
			}).unwrap();
			// Make sure citeproc-rs has all the locales it needs
			// await this.driver.fetchAll();
		}
		
		_fetchLocale(lang) {
			return Zotero.Cite.System.prototype.retrieveLocale(lang);
		}
		
		// No way to change the output format on a live Driver
		setOutputFormat(format) {
			if (this._format != format) {
				this._format = format;
				this._resetDriver();
			}
		}
		
		_insertCitationReferences(citation) {
			let cites = [];
			for (const citationItem of citation.citationItems) {
				let citeprocItem = this.sys.retrieveItem(citationItem.id);
				citeprocItem.id = `${citeprocItem.id}`;
				Zotero.debug(`CiteprocRs: insertReference ${JSON.stringify(citeprocItem)}`, 5);
				this._driver.insertReference(citeprocItem).unwrap();
				cites.push({ id: `${citeprocItem.id}`, locator: undefined, locators: undefined });
			}
			return cites;
		}

		_getClusterOrder(citations) {
			let clusters = [];
			for (let [citationID, noteIndex] of citations) {
				let cluster = { id: citationID };
				noteIndex = typeof noteIndex == "string" ? parseInt(noteIndex) : noteIndex;
				if (noteIndex) {
					cluster.note = noteIndex;
				}
				clusters.push(cluster);
			}
			return clusters;
		}

		previewCitationCluster(citation, citationsPre, citationsPost, outputFormat) {
			if (!citation.citationID) citation.citationID = Zotero.Utilities.randomString(10);
			
			let cites = this._insertCitationReferences(citation);
			
			let thisClusterOrder = { };
			let noteIndex = citation.properties.noteIndex;
			noteIndex = typeof noteIndex == "string" ? parseInt(noteIndex) : noteIndex;
			if (noteIndex) {
				thisClusterOrder.note = noteIndex;
			}
			let allClusterOrder = this._getClusterOrder(citationsPre.concat(citationsPost));
			allClusterOrder.splice(citationsPre.length, 0, thisClusterOrder);
			
			Zotero.debug(`CiteprocRs: previewCitationCluster ${JSON.stringify([cites, allClusterOrder, outputFormat])}`, 5);
			return this._driver.previewCitationCluster(cites, allClusterOrder, outputFormat).unwrap();
		}
		
		insertCluster(citation) {
			let cluster = { id: citation.citationID };
			cluster.cites = this._insertCitationReferences(citation);

			Zotero.debug(`CiteprocRs: insertCluster ${JSON.stringify(cluster)}`, 5);
			this._driver.insertCluster(cluster).unwrap();
			return cluster;
		}
	
		setClusterOrder(citations) {
			let clusters = this._getClusterOrder(citations);
			Zotero.debug(`CiteprocRs: setClusterOrder ${JSON.stringify(clusters)}`, 5);
			this._driver.setClusterOrder(clusters).unwrap();
		}
		
		getBatchedUpdates() {
			Zotero.debug(`CiteprocRs: batchedUpdates`, 5);
			let updateSummary = this._driver.batchedUpdates().unwrap();
			updateSummary.clusters = updateSummary.clusters.map(([id, output]) => {
				return [id, output];
			});
			return updateSummary;
		}
		
		rebuildProcessorState(citations, format, uncited) {
			this._format = format;
			this._resetDriver();
			for (let citation of citations) {
				this.insertCluster(citation);
			}
			this.setClusterOrder(citations.map(
				citation => [citation.citationID, citation.properties.noteIndex]));
			this.updateUncitedItems(uncited);
		}
		
		updateUncitedItems(itemIDs) {
			let referenceIDs = [];
			for (let id of itemIDs) {
				let citeprocItem = this.sys.retrieveItem(id);
				citeprocItem.id = `${citeprocItem.id}`;
				referenceIDs.push(citeprocItem.id);
				Zotero.debug(`CiteprocRs: insertReference ${JSON.stringify(citeprocItem)}`, 5);
				this._driver.insertReference(citeprocItem).unwrap();
			}
			Zotero.debug(`CiteprocRs: includeUncitedItems ${JSON.stringify(referenceIDs)}`);
			this._driver.includeUncited({ Specific: referenceIDs }).unwrap();
		}
		
		makeBibliography() {
			Zotero.debug(`CiteprocRs: bibliographyMeta`, 5);
			
			// Converting from the wrongly documented citeproc-rs return format
			// to the awfully named citeproc-js format. Sigh.
			let bibliographyMeta = this._driver.bibliographyMeta().unwrap();
			bibliographyMeta = Object.assign(bibliographyMeta, {
				maxoffset: bibliographyMeta.maxOffset,
				linespacing: bibliographyMeta.lineSpacing,
				entryspacing: bibliographyMeta.entrySpacing,
				hangingindent: bibliographyMeta.hangingIndent,
				bibstart: bibliographyMeta.formatMeta && bibliographyMeta.formatMeta.markupPre,
				bibend: bibliographyMeta.formatMeta && bibliographyMeta.formatMeta.markupPost,
			});
			bibliographyMeta['second-field-align'] = bibliographyMeta.secondFieldAlign;
			
			Zotero.debug(`CiteprocRs: makeBibliography`, 5);
			const bibliographyEntries = this._driver.makeBibliography().unwrap();
			// Crazy citeproc-rs behavior here
			const entry_ids = bibliographyEntries.map(entry => [entry.id]);
			const strings = bibliographyEntries.map(entry => entry.value);
			return [
				Object.assign({ entry_ids }, bibliographyMeta),
				strings
			];
		}
	},
};

