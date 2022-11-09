// This code connects toggl time entries to Notion tasks. 
// Notion cards are populated into tags in Toggl. 
// Tagged toggl time entries are accumulated and stored in the notion card they reference
// Assumes the Notion database has two schema items:
// - CardIdentifier: 5 digit uuid (formula property. formula: 'slice(id(), 27)')
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
  try {
    const response = await notion.databases.query({
      database_id: notionDatabaseId,
    })

    const titles = response.results.map((r) => {
      const cardId = r.properties.CardIdentifier.formula.string
      const cardTitle = r.properties.Name.title[0].plain_text.replace(" ", "-")
      const tagTitle = cardId + "-" + cardTitle

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

// filters out cards that already have an associated tag
const getTagsToAdd = (cardsFromNotion, existingTagTitles) => {
  return cardsFromNotion.filter(
    (c) => !existingTagTitles.find((t) => t === c.tagTitle)
  ).map(c => c.tagTitle)
}


const addTagToToggl = async (tagTitle) => {
  try {
    await axios.post(`https://api.track.toggl.com/api/v9/workspaces/${togglWorkspaceId}/tags`, 
      {name: tagTitle, workspace_id: 6833844}, 
      {headers: togglHeaders}
    )
  }
  catch (e) {
    console.log('error')
    console.log(e)
  }
}

const addTagsToToggl = async (tags) => {
  for (const tag of tags)
    await addTagToToggl(tag)
}


const updateTagsInTogglFromNotion = async () => {
  // get ids to make tags
  const tagTitles = await getTagTitlesFromNotion()

  // see which tags are already in toggl
  const existingTags = await getExistingTogglTags()

  // filter tags that arent in there yet (not strictly necessary since toggl's api does this too)
  const tagsToAdd = getTagsToAdd(tagTitles, existingTags)

  // add tags that aren't in there yet
  addTagsToToggl(tagsToAdd)
}

// get all the entries in toggl, sorted by tag
const getTogglEntriesByTag = async () => {
  let entries = []
  try {
    const {data: tags} = await axios.get(`https://api.track.toggl.com/api/v9/workspaces/${togglWorkspaceId}/tags`, {headers: togglHeaders})

    for (const tag of tags) {
      const {data: tagEntries} = await axios.post(
      `https://api.track.toggl.com/reports/api/v3/workspace/${togglWorkspaceId}/search/time_entries`,
      {start_date: '2022-10-01', end_date: '2022-11-09', tag_ids: [tag.id]},
      {headers: togglHeaders})

      const item = {tag: tag, tagEntries: tagEntries}
      
      if (tagEntries.length > 0)
        entries.push({tag, tagEntries})
    }

    return entries
  }
  catch (e) {
    console.log('error')
    console.log(e.message)
  }
}

// strips the card id from the tag title
const cardIdFromTagTitle = (title) => {
  const spl = title.split('-')
  if (spl.length < 1)
    return ''
  
  if (spl[0].length !== 5)
    return ''

  return spl[0]
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
        property: 'CardIdentifier',
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
  for (const t of timePerTag) {
    const pageId = await getPageIdWithCardId(t.cardId)
    await updatePageWithTime(pageId, t.totalTimeHours)
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



