// The catalogue of outlets and topics readers pick from when they set up their page
// (config/catalogue.json). Outlets are news sites with one feed per section; a section topic
// becomes a card that merges the chosen outlets' feeds for that section. Other topics have
// fixed sources of their own, either listed inline or borrowed from a card in feeds.json.

export const REGIONS = ['uk', 'us'];
export const SECTIONS = ['top', 'politics', 'world', 'business', 'science', 'health', 'sport', 'culture'];
const PAYWALLS = ['metered', 'hard'];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isFeedUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// Every feed the catalogue can ask for, with a stable id: `<outlet>.<section>` for outlet
// feeds, `<topic>.<n>` for a topic's own sources. Topics borrowing a feeds.json card add
// nothing here; those feeds are fetched for the default page already.
export function catalogueSources(catalogue) {
  const sources = [];
  for (const [outlet, { name, sections }] of Object.entries(catalogue.outlets)) {
    for (const [section, url] of Object.entries(sections)) sources.push({ id: `${outlet}.${section}`, name, url });
  }
  for (const [topic, { sources: own = [] }] of Object.entries(catalogue.topics)) {
    own.forEach(({ name, url }, i) => sources.push({ id: `${topic}.${i + 1}`, name, url }));
  }
  return sources;
}

// Problems with the catalogue, as readable messages; empty when it's sound. `widgets` is
// feeds.json's cards, which topics may borrow.
export function catalogueProblems(catalogue, widgets = {}) {
  const problems = [];
  const outlets = Object.entries(catalogue.outlets ?? {});
  const topics = Object.entries(catalogue.topics ?? {});

  for (const [id, outlet] of outlets) {
    if (!ID.test(id)) problems.push(`Outlet id "${id}" should be lower-case words joined by hyphens.`);
    if (!outlet.name) problems.push(`Outlet ${id} has no name.`);
    if (!REGIONS.includes(outlet.region)) problems.push(`Outlet ${id} has region "${outlet.region}"; use ${REGIONS.join(' or ')}.`);
    if (outlet.paywall !== undefined && !PAYWALLS.includes(outlet.paywall)) problems.push(`Outlet ${id} has paywall "${outlet.paywall}"; use ${PAYWALLS.join(' or ')}.`);
    if (!outlet.sections?.top) problems.push(`Outlet ${id} has no "top" feed (used for its own card).`);
    for (const [section, url] of Object.entries(outlet.sections ?? {})) {
      if (!SECTIONS.includes(section)) problems.push(`Outlet ${id} has unknown section "${section}".`);
      if (!isFeedUrl(url)) problems.push(`Outlet ${id} section ${section} isn't an https address.`);
    }
  }

  for (const [id, topic] of topics) {
    if (!ID.test(id)) problems.push(`Topic id "${id}" should be lower-case words joined by hyphens.`);
    if (!topic.label) problems.push(`Topic ${id} has no label.`);
    if (topic.region !== undefined && !REGIONS.includes(topic.region)) problems.push(`Topic ${id} has region "${topic.region}"; use ${REGIONS.join(' or ')}.`);
    const kinds = ['section', 'sources', 'widget'].filter((key) => topic[key] !== undefined);
    if (kinds.length !== 1) {
      problems.push(`Topic ${id} needs exactly one of section, sources or widget.`);
      continue;
    }
    if (topic.section !== undefined) {
      if (!SECTIONS.includes(topic.section)) problems.push(`Topic ${id} uses unknown section "${topic.section}".`);
      // A section topic is only worth offering if each region it's offered in has outlets for it.
      for (const region of topic.region ? [topic.region] : REGIONS) {
        const count = outlets.filter(([, outlet]) => outlet.region === region && outlet.sections?.[topic.section]).length;
        if (count < 2) problems.push(`Topic ${id} has ${count} ${region.toUpperCase()} outlet${count === 1 ? '' : 's'} with a "${topic.section}" feed; it needs at least 2.`);
      }
    }
    if (topic.sources !== undefined) {
      if (!Array.isArray(topic.sources) || !topic.sources.length) problems.push(`Topic ${id} has no sources.`);
      else topic.sources.forEach((source, i) => {
        if (!source.name || !isFeedUrl(source.url)) problems.push(`Topic ${id} source ${i + 1} needs a name and an https url.`);
      });
    }
    if (topic.widget !== undefined && !widgets[topic.widget]) problems.push(`Topic ${id} borrows card "${topic.widget}", which isn't in feeds.json.`);
  }

  const outletIds = new Set(outlets.map(([id]) => id));
  const topicIds = new Set(topics.map(([id]) => id));
  for (const region of REGIONS) {
    const defaults = catalogue.defaults?.[region];
    if (!defaults) {
      problems.push(`No defaults for ${region.toUpperCase()}.`);
      continue;
    }
    for (const id of defaults.outlets ?? []) {
      if (!outletIds.has(id)) problems.push(`${region.toUpperCase()} default outlet "${id}" isn't in the catalogue.`);
      else if (catalogue.outlets[id].region !== region) problems.push(`${region.toUpperCase()} default outlet "${id}" is from another region.`);
    }
    for (const id of defaults.topics ?? []) {
      const topicRegion = catalogue.topics[id]?.region;
      if (!topicIds.has(id)) problems.push(`${region.toUpperCase()} default topic "${id}" isn't in the catalogue.`);
      else if (topicRegion && topicRegion !== region) problems.push(`${region.toUpperCase()} default topic "${id}" is for another region.`);
    }
    if (!defaults.outlets?.length || !defaults.topics?.length) problems.push(`${region.toUpperCase()} defaults need at least one outlet and one topic.`);
  }
  return problems;
}

// What the setup screen needs, served at /api/catalogue.json: names, regions, paywalls and
// which feeds each choice draws on (as catalogueSources ids), without the feed addresses.
export function publicCatalogue(catalogue) {
  return {
    regions: REGIONS,
    sections: SECTIONS,
    outlets: Object.fromEntries(Object.entries(catalogue.outlets).map(([id, outlet]) => [id, {
      name: outlet.name,
      region: outlet.region,
      ...(outlet.paywall && { paywall: outlet.paywall }),
      sections: Object.keys(outlet.sections),
    }])),
    topics: Object.fromEntries(Object.entries(catalogue.topics).map(([id, topic]) => [id, {
      label: topic.label,
      ...(topic.region && { region: topic.region }),
      ...(topic.section && { section: topic.section }),
      ...(topic.widget && { widget: topic.widget }),
      ...(topic.sources && { sources: topic.sources.map(({ name }, i) => ({ id: `${id}.${i + 1}`, name })) }),
    }])),
    defaults: catalogue.defaults,
  };
}
