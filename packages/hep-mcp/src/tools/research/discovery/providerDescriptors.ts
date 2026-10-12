import {
  DiscoveryProviderDescriptorSchema,
  type DiscoveryProviderDescriptor,
} from '@nullius/shared';
import { ARXIV_DISCOVERY_DESCRIPTOR } from '@nullius/arxiv-mcp/tooling';
import { OPENALEX_DISCOVERY_DESCRIPTOR } from '@nullius/openalex-mcp/tooling';

export const INSPIRE_DISCOVERY_DESCRIPTOR: DiscoveryProviderDescriptor = DiscoveryProviderDescriptorSchema.parse({
  provider: 'inspire',
  display_name: 'INSPIRE-HEP',
  capabilities: {
    supports_keyword_search: true,
    supports_semantic_search: false,
    supports_citation_graph: true,
    supports_fulltext: true,
    supports_source_download: true,
    supports_open_access_content: true,
  },
  supported_intents: ['known_item', 'keyword_search', 'citation_expansion', 'fulltext_search'],
  notes: 'Capability descriptor for the INSPIRE-HEP provider tools. Multi-hop discovery, same-work deduplication and ranking across providers are done by the agent with these tools, following the literature-workflows recipes.',
});

export const DISCOVERY_PROVIDER_DESCRIPTORS: DiscoveryProviderDescriptor[] = [
  INSPIRE_DISCOVERY_DESCRIPTOR,
  DiscoveryProviderDescriptorSchema.parse(OPENALEX_DISCOVERY_DESCRIPTOR),
  DiscoveryProviderDescriptorSchema.parse(ARXIV_DISCOVERY_DESCRIPTOR),
];
