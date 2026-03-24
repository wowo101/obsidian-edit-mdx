import { Plugin, normalizePath, TFile, MetadataCache, Vault, HoverPopover, MarkdownRenderer } from 'obsidian';

export default class MdxTools extends Plugin {

	private originalGetFirstLinkpathDest: MetadataCache['getFirstLinkpathDest'] | null = null;
	private originalGetMarkdownFiles: Vault['getMarkdownFiles'] | null = null;

	async onload() {
		super.onload()

		this.registerExtensions(["mdx"], "markdown");
		this.patchVaultMarkdownFiles();
		this.patchLinkResolution();
		this.registerMdxHoverPreview();

		this.addRibbonIcon('add-note-glyph', 'New .mdx file', (evt: MouseEvent) => {
			this.createMDX()
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				menu.addItem((item) => {
					item
					.setTitle("New .mdx file")
					.setIcon("add-note-glyph")
					.onClick(async () => {
						let folder : string
						const fname = file.path
						if( fname.search("(\\.[^.]+)$") > 0  && file.parent) {
							folder = file.parent.path
						} else {
							folder = fname
						}
						this.createMDX(folder)
					});
				});
			})
		);

	}

	onunload() {
		this.unpatchLinkResolution();
		this.unpatchVaultMarkdownFiles();
	}

	/**
	 * Monkey-patch Vault.getMarkdownFiles so that .mdx files are included
	 * in the set of "markdown files". This causes the MetadataCache to index
	 * them, which enables backlinks and graph view natively.
	 */
	patchVaultMarkdownFiles() {
		const vault = this.app.vault;
		this.originalGetMarkdownFiles = vault.getMarkdownFiles.bind(vault);

		vault.getMarkdownFiles = (): TFile[] => {
			const mdFiles = this.originalGetMarkdownFiles!();
			const mdxFiles = vault.getFiles().filter(
				(f) => f.extension === 'mdx'
			);
			return [...mdFiles, ...mdxFiles];
		};
	}

	unpatchVaultMarkdownFiles() {
		if (this.originalGetMarkdownFiles) {
			this.app.vault.getMarkdownFiles = this.originalGetMarkdownFiles;
			this.originalGetMarkdownFiles = null;
		}
	}

	/**
	 * Monkey-patch MetadataCache.getFirstLinkpathDest so that wikilinks
	 * like [[MyNote]] resolve to MyNote.mdx when no .md file matches.
	 */
	patchLinkResolution() {
		const cache = this.app.metadataCache;
		this.originalGetFirstLinkpathDest = cache.getFirstLinkpathDest.bind(cache);

		cache.getFirstLinkpathDest = (linkpath: string, sourcePath: string): TFile | null => {
			const result = this.originalGetFirstLinkpathDest!(linkpath, sourcePath);
			if (result) return result;

			const allFiles = this.app.vault.getFiles();
			const candidates = allFiles.filter(
				(f) => f.extension === 'mdx' && f.basename === linkpath
			);

			if (candidates.length === 1) {
				return candidates[0];
			}

			if (candidates.length > 1) {
				const sourceDir = sourcePath.substring(0, sourcePath.lastIndexOf('/'));
				const sorted = candidates.sort((a, b) => {
					const aDir = a.path.substring(0, a.path.lastIndexOf('/'));
					const bDir = b.path.substring(0, b.path.lastIndexOf('/'));
					if (aDir === sourceDir && bDir !== sourceDir) return -1;
					if (bDir === sourceDir && aDir !== sourceDir) return 1;
					return a.path.length - b.path.length;
				});
				return sorted[0];
			}

			return null;
		};
	}

	/**
	 * Handle hover previews for .mdx files. The built-in page-preview plugin
	 * skips .mdx files even when they're in the metadata cache. We listen for
	 * the hover-link event, and when the target is an .mdx file, we create a
	 * HoverPopover and render the markdown content into it ourselves.
	 */
	registerMdxHoverPreview() {
		this.registerEvent(
			// @ts-ignore — hover-link is an internal workspace event
			this.app.workspace.on('hover-link', (e: {
				event: MouseEvent;
				source: string;
				hoverParent: { hoverPopover: HoverPopover | null };
				targetEl: HTMLElement;
				linktext: string;
				sourcePath: string;
			}) => {
				const file = this.app.metadataCache.getFirstLinkpathDest(e.linktext, e.sourcePath);
				if (!file || file.extension !== 'mdx') return;

				// Let the file explorer show its native tooltip (created/modified dates)
				if (e.source === 'file-explorer' || e.source === 'search') return;

				// Don't create a second popover if one is already showing
				if (e.hoverParent.hoverPopover) return;

				// Read file and render preview in a HoverPopover
				this.app.vault.cachedRead(file).then((content) => {
					// Bail if a popover appeared while we were reading
					if (e.hoverParent.hoverPopover) return;

					// Separate frontmatter from body
					const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
					const frontmatter = fmMatch ? fmMatch[1] : '';
					const body = fmMatch ? fmMatch[2] : content;

					// Strip MDX-specific syntax (imports, JSX components)
					const cleanBody = body
						.replace(/^import\s+.*$/gm, '')
						.replace(/<\w[^>]*client:[^>]*\/>/g, '')
						.replace(/<\w[^>]*client:[^>]*>[\s\S]*?<\/\w+>/g, '')
						.trim();

					const popover = new HoverPopover(e.hoverParent, e.targetEl, 300);

					// Replicate native page-preview DOM structure:
					// .hover-popover > .markdown-embed > .markdown-embed-content > .markdown-preview-view
					const embedEl = popover.hoverEl.createDiv({ cls: 'markdown-embed is-loaded' });
					const embedContentEl = embedEl.createDiv({ cls: 'markdown-embed-content' });
					const previewEl = embedContentEl.createDiv({
						cls: 'markdown-preview-view markdown-rendered show-properties',
					});

					// Render frontmatter properties (collapsed, matching native structure)
					if (frontmatter) {
						this.renderProperties(previewEl, frontmatter);
					}

					// Render markdown body
					const sizerEl = previewEl.createDiv({
						cls: 'markdown-preview-sizer markdown-preview-section',
					});

					MarkdownRenderer.render(
						this.app,
						cleanBody,
						sizerEl,
						file.path,
						popover
					);
				});
			})
		);
	}

	/**
	 * Render a collapsible properties section matching native Obsidian style.
	 */
	private renderProperties(parentEl: HTMLElement, frontmatter: string) {
		const props: { key: string; value: string; type: string }[] = [];
		for (const line of frontmatter.split('\n')) {
			const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
			if (!kvMatch) continue;
			const [, key, rawValue] = kvMatch;
			const value = rawValue.replace(/^["']|["']$/g, '');
			const type = /^\d+(\.\d+)?$/.test(value) ? 'number' : 'text';
			props.push({ key, value, type });
		}

		if (props.length === 0) return;

		const metaContainer = parentEl.createDiv({ cls: 'metadata-container is-collapsed' });
		metaContainer.tabIndex = -1;
		metaContainer.setAttr('data-property-count', String(props.length));

		// Collapsible heading with triangle icon
		const heading = metaContainer.createDiv({ cls: 'metadata-properties-heading is-collapsed' });
		heading.tabIndex = 0;
		const collapseIcon = heading.createDiv({ cls: 'collapse-indicator collapse-icon is-collapsed' });
		const triangleSvg = this.createSvgIcon('right-triangle', 'M3 8L12 17L21 8');
		collapseIcon.appendChild(triangleSvg);
		heading.createDiv({ cls: 'metadata-properties-title', text: 'Properties' });

		// Content (hidden when collapsed)
		const metaContent = metaContainer.createDiv({ cls: 'metadata-content' });
		metaContent.style.display = 'none';
		const metaPropsEl = metaContent.createDiv({ cls: 'metadata-properties' });

		for (const prop of props) {
			const propEl = metaPropsEl.createDiv({ cls: 'metadata-property' });
			propEl.tabIndex = 0;
			propEl.setAttr('data-property-key', prop.key);

			const keyEl = propEl.createDiv({ cls: 'metadata-property-key' });
			const iconSpan = keyEl.createSpan({ cls: 'metadata-property-icon' });
			if (prop.type === 'number') {
				iconSpan.appendChild(this.createSvgIcon('lucide-binary',
					'M14 14h4v6H14zM6 4h4v6H6zM6 20h4M14 10h4M6 14h2v6M14 4h2v6'));
			} else {
				iconSpan.appendChild(this.createSvgIcon('lucide-text',
					'M21 5H3M15 12H3M17 19H3'));
			}
			keyEl.createEl('input', {
				cls: 'metadata-property-key-input',
				attr: { type: 'text', 'aria-label': prop.key, readonly: '' },
				value: prop.key,
			});

			const valueEl = propEl.createDiv({ cls: 'metadata-property-value' });
			valueEl.setAttr('data-property-type', prop.type);
			if (prop.type === 'number') {
				valueEl.createEl('input', {
					cls: 'metadata-input metadata-input-number',
					attr: { type: 'number', readonly: '' },
					value: prop.value,
				});
			} else {
				const textEl = valueEl.createDiv({
					cls: 'metadata-input-longtext',
					text: prop.value,
				});
				textEl.setAttr('contenteditable', 'false');
			}
		}

		// Toggle collapse on click
		heading.addEventListener('click', () => {
			const collapsed = metaContainer.hasClass('is-collapsed');
			if (collapsed) {
				metaContainer.removeClass('is-collapsed');
				heading.removeClass('is-collapsed');
				collapseIcon.removeClass('is-collapsed');
				metaContent.style.display = '';
			} else {
				metaContainer.addClass('is-collapsed');
				heading.addClass('is-collapsed');
				collapseIcon.addClass('is-collapsed');
				metaContent.style.display = 'none';
			}
		});
	}

	/**
	 * Create an SVG icon element matching Obsidian's svg-icon pattern.
	 * paths is a space-separated list of d attributes for <path> elements,
	 * or a compound string with M-commands that gets split into individual paths.
	 */
	private createSvgIcon(cls: string, paths: string): SVGElement {
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('xmlns', NS);
		svg.setAttribute('width', '24');
		svg.setAttribute('height', '24');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		svg.classList.add('svg-icon', cls);

		// Split on 'M' to get individual path segments
		const segments = paths.split(/(?=M)/).filter(s => s.trim());
		for (const d of segments) {
			const path = document.createElementNS(NS, 'path');
			path.setAttribute('d', d.trim());
			svg.appendChild(path);
		}

		return svg;
	}

	unpatchLinkResolution() {
		if (this.originalGetFirstLinkpathDest) {
			this.app.metadataCache.getFirstLinkpathDest = this.originalGetFirstLinkpathDest;
			this.originalGetFirstLinkpathDest = null;
		}
	}

	checkExists(filepath : string) {
		return this.app.vault.getAbstractFileByPath(filepath) && true;
	}

	// Create new MDX file
	createMDX(folder? : string) {
		if ( !folder ) {
			folder = this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path || '').path
		}

		let filename = normalizePath(folder + "/Untitled.mdx")

		if (!this.checkExists(filename)) {
			this.app.vault.create(filename, "")
		}
		else { // If Untitled.mdx already exists, try Untitled 1.mdx etc
			let iter = 0
			while (true) {
				iter = iter + 1
				filename = normalizePath(folder + "/Untitled " + iter + ".mdx")
				if (!this.checkExists(filename)) {
					this.app.vault.create(filename, "")
					break
				}
			}
		}


	}
}
