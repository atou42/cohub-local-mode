<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import { mediaLightbox } from "$lib/components/media-lightbox.svelte";
import { protectedRelayMedia, publicMediaSource } from "$lib/protected-relay-media";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;

type Props = {
	blocks: ImageBlock[];
};

const { blocks }: Props = $props();

function getImagePreviewSrc(block: ImageBlock): string {
	if (block.source.type === "url") return block.source.url;
	return `data:${block.source.media_type};base64,${block.source.data}`;
}

function getImageAlt(block: ImageBlock, index: number): string {
	return String(block._meta?.filename ?? `attachment-${index + 1}`);
}
</script>

{#if blocks.length > 0}
	<div class="grid grid-cols-2 gap-2 max-w-md">
		{#each blocks as block, index}
			<button
				type="button"
				class="group overflow-hidden rounded-2xl border border-border-subtle bg-bg-content p-0 cursor-zoom-in"
				onclick={() => {
					const gallery = blocks.map((b, i) => ({
						src: getImagePreviewSrc(b),
						type: "image" as const,
						alt: getImageAlt(b, i),
					}));
					mediaLightbox.show(gallery, index);
				}}
			>
				<img src={publicMediaSource(getImagePreviewSrc(block))} use:protectedRelayMedia={getImagePreviewSrc(block)} alt={getImageAlt(block, index)} class="h-36 w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
			</button>
		{/each}
	</div>
{/if}
