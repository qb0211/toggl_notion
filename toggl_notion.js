// This code connects toggl time entries to Notion tasks. 
// Notion cards are populated into tags in Toggl. 
// Tagged toggl time entries are accumulated and stored in the notion card they reference
// Assumes the Notion database has two schema items:
// - CardId: 5 digit uuid (formula property. formula: 'slice(id(), 27)')
// - TimeSpent: number

const nodefetch = require("node-fetch")
const axios = require('axios')

require("dotenv").config()
const base64 = require("base-64")

const { Client } = require("@notionhq/client")

const notionDatabaseId = process.env.NOTION_DATABASE_ID
const togglWorkspaceId = process.env.TOGGL_WORKSPACE_ID

const notion = new Client({ auth: process.env.NOTION_API_KEY })
const togglHeaders = {
  "Content-Type": "application/json",
  Authorization: `Basic ${base64.encode(
    `${process.env.TOGGL_API_KEY}:api_token`
  )}`,
}

// this gets tag title for all entries in the database
const getTagTitlesFromNotion = async () => {
  let results = []
  try {
    let hasMore = false
    let cursor = undefined

    do {
      const response = await notion.databases.query({
        database_id: notionDatabaseId,
        start_cursor: cursor
      })

      results = [...results, ...response.results]

      hasMore = response.has_more

      if (hasMore)
        cursor = response.next_cursor

    } while (hasMore)

    const titles = results.map((r) => {
      const cardId = r.properties.CardId.formula.string
      const cardTitle = r.properties.Projects.title[0].text.content
      const tagTitle = cardId + ": " + cardTitle

      return { cardId, cardTitle, tagTitle }
    })

    return titles
  } catch (e) {
    console.log('error')
    console.log(e.message)
  }
}

// get the existing tags in toggl
const getExistingTogglTags = async () => {
  try {
    const result = await nodefetch(
      `https://api.track.toggl.com/api/v9/workspaces/${togglWorkspaceId}/tags`,
      {
        method: "GET",
        headers: togglHeaders,
      }
    )

    const json = await result.json()
    return json.map((r) => r.name)
  }
  catch (e) {
    console.log('error')
    console.log(e)
  }
}

// strips the card id from the tag title
const cardIdFromTagTitle = (title) => {
  const spl = title.split(':')
  if (spl.length < 1)
    return ''
  
  if (spl[0].length !== 5)
    return ''

  return spl[0]
}

// filters out cards that already have an associated tag
const getTagsToAdd = (cardsFromNotion, existingTagTitles) => {
  return cardsFromNotion.filter(
    (c) => !existingTagTitles.find((t) => cardIdFromTagTitle(t) === c.cardId)
  ).map(c => c.tagTitle)
}

function sleep(milliseconds) {
  const date = Date.now();
  let currentDate = null;
  do {
    currentDate = Date.now();
  } while (currentDate - date < milliseconds);
}

const addTagToToggl = async (tagTitle) => {
  const body = {name: tagTitle, workspace_id: parseInt(togglWorkspaceId)}
  console.log(body)
  try {
    await axios.post(`https://api.track.toggl.com/api/v9/workspaces/${togglWorkspaceId}/tags`, 
      body, 
      {headers: togglHeaders}
    )
  }
  catch (e) {
    console.log('error')
    console.log(e.message)
  }
}

const addTagsToToggl = async (tags) => {
  let i = 1
  let len = tags.length;

  for (const tag of tags) {
    await addTagToToggl(tag)
    sleep(500)
    console.log(`Adding Tag ${tag} (${i++} of ${len})...`)
  }
}


const updateTagsInTogglFromNotion = async () => {
  // get ids to make tags
  const tagTitles = await getTagTitlesFromNotion()

  // see which tags are already in toggl
  const existingTags = await getExistingTogglTags()

  // filter tags that arent in there yet (not strictly necessary since toggl's api does this too)
  const tagsToAdd = existingTags.length > 0 ? getTagsToAdd(tagTitles, existingTags) : tagTitles

  // add tags that aren't in there yet
  addTagsToToggl(tagsToAdd)
}

// get all the entries in toggl, sorted by tag
const getTogglEntriesByTag = async () => {
  let entries = []
  try {
    const {data: tags} = await axios.get(`https://api.track.toggl.com/api/v9/workspaces/${togglWorkspaceId}/tags`, {headers: togglHeaders})

    let i = 1
    let len = tags.length

    for (const tag of tags) {
      console.log(`Getting time entries for tag ${tag.name} (${i++} of ${len})`)
      const {data: tagEntries} = await axios.post(
      `https://api.track.toggl.com/reports/api/v3/workspace/${togglWorkspaceId}/search/time_entries`,
      {start_date: '2022-10-01', end_date: '2022-11-09', tag_ids: [tag.id]},
      {headers: togglHeaders})

      const item = {tag: tag, tagEntries: tagEntries}
      
      if (tagEntries.length > 0)
        entries.push({tag, tagEntries})

      sleep(500)
    }

    return entries
  }
  catch (e) {
    console.log('error')
    console.log(e.message)
  }
}

// accumulate all the time spent on entries with a particular tag
const getTimePerTag = async () => {
  const entries = await getTogglEntriesByTag()
  const data = entries.map(e => {

    let totalTime = 0

    for (const entry of e.tagEntries) {
      for (const timeEntry of entry.time_entries) {
        totalTime += timeEntry.seconds
      }
    }

    return {cardId: cardIdFromTagTitle(e.tag.name), totalTimeHours: totalTime / 3600}
  })

  return data
}

// gets the id of a notion page that contains a card id
const getPageIdWithCardId = async (cardId) => {
  try {
    const response = await notion.databases.query({
      database_id: notionDatabaseId,
      filter: {
        property: 'CardId',
        formula: {string: {equals: cardId}},
      },
    })

    return response.results && response.results.length > 0 ? response.results[0].id : ''
  }
  catch (e) {
    console.log('error')
    console.log(e.message)
  }
}

// updates the page with the given id to have the given time
const updatePageWithTime = async (pageId, timeHours) => {
  const response = await notion.pages.update({
    page_id: pageId,
    properties: {
      'TimeSpent': {
        number: timeHours,
      },
    },
  })
}

// updates all the notion pages with the time in toggl per tag
const updatePagesWithTime = async () => {
  const timePerTag = await getTimePerTag()
  let i = 0
  let len = timePerTag.length

  for (const t of timePerTag) {
    console.log(` Updating time in Notion for ${t.cardId} (${i++} of ${len})`)
    const pageId = await getPageIdWithCardId(t.cardId)
    sleep(350)
    await updatePageWithTime(pageId, t.totalTimeHours)
    sleep(350)
  }
}


async function main() {
  
  // PART 1: Notion cards to Toggl tags
  console.log('updating tags in Toggl from Notion...')
  await updateTagsInTogglFromNotion()

  // PART 2: Tagged Toggl time entries to Notion cards
  console.log('updating Notion cards with time from Toggl...')
  await updatePagesWithTime()

  console.log('finished.')
}

main()



