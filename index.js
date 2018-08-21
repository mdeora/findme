'use strict';

const fetch = require('node-fetch')
const openwhisk = require('openwhisk');
const redis = require('./lib/redis.js')
const twitter = require('./lib/twitter.js')
const jobs = require('./lib/jobs.js')

const schedule_search = async params => {
  if (!params.redis) throw new Error('Missing redis connection URL from event parameters')

  const client = redis(params.redis)
  const job_id = await jobs.create(client, params.query, params.user)
  console.log('created new job id:', job_id)

  const ow = openwhisk()
  const name = 'search_request'
  const trigger_params = {id: job_id, query: params.query, user: params.user}
  console.time('firing trigger')
  return ow.triggers.invoke({name, params: trigger_params}).then(result => {
    console.timeEnd('firing trigger')
    return { job_id }
  }).catch(err => {
    console.error('failed to fire trigger', err)
    return { error: 'failed to fire trigger' }
  })
}

const twitter_search = async params => {
  if (!params.query) throw new Error('Missing query parameter from event parameters')
  if (!params.user) throw new Error('Missing user parameter from event parameters')
  if (!params.id) throw new Error('Missing job id parameter from event parameters')
  if (!params.redis) throw new Error('Missing redis connection URL from event parameters')

  const client = redis(params.redis)

  console.log(`finding images for search query (${params.query}) for user: ${params.user}`) 
  const results = await twitter.find_images(params.query)
  console.log(`twitter search returned ${results.images.length} images from ${results.total} tweets`)

  console.time('save_results')
  await jobs.save_results(client, params.id, results.total, results.images.length)
  console.timeEnd('save_results')
  const name = 'tweet_image'
  const ow = openwhisk()

  console.time('send triggers')
  const triggers = results.images.map(image => {
    const trigger_params = { job: params.id, tweets: [image] }
    return ow.triggers.invoke({name, params: trigger_params})
  })

  await Promise.all(triggers)
  console.timeEnd('send triggers')
  return { tweets: results.total, images: results.images.length }
}

const memoryUsage = () => {
  let used = process.memoryUsage();
  const values = []
  for (let key in used) {
    values.push(`${key}=${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
  }

  return `memory used: ${values.join(', ')}`
}
   /**
  console.log(profile_face.length)
  console.log(profile_face)
  const uints = new Uint8Array(profile_face.buffer);
  console.log(Buffer.from(uints).toString('hex'));
  console.log(uints.length)
  console.log(uints.buffer.toString('hex'))
  const floaters = new Float32Array(uints.buffer);
  console.log(floaters.length)
  */


// NEED MORE LOGS?
// HOW TO REMOVE TF-JS FROM PACKAGE?
// NEED TO LOAD MODELS FROM THE FILESYSTEM
const compare_images = async params => {
  const compare = require('./lib/compare.js')
  if (!params.job) throw new Error('Missing job parameter from event parameters')
  if (!params.tweets) throw new Error('Missing tweets parameter from event parameters')
  if (!params.redis) throw new Error('Missing redis connection URL from event parameters')


  //find profile url for user
  const client = redis(params.redis)
  console.log(`retrieving job details: ${params.job}`)
  const job = await jobs.retrieve(client, params.job) 
  console.log(`found job details:`, job)
  console.time('profile_image')
  const profile_image = await twitter.profile_image(job.user) 
  console.timeEnd('profile_image')

  //const profile = Buffer.from(params.image, 'base64')
  console.log('looking for faces in profile image.')
  const profile_faces = await compare.find_faces(profile_image)
  console.log(`found ${profile_faces.length} faces in profile.`)
  console.log(memoryUsage())
  console.time('gc')
  global.gc();
  console.timeEnd('gc')
  console.log(memoryUsage())
  // what if profile has no face?
  const profile_face = profile_faces[0].descriptor
   const match_tweet = async tweet => {
    const url = tweet.url
    console.log('retrieving new image @', url)
    try {
      console.time(`fetch ${url}`)
      const res = await fetch(url)
      console.timeEnd(`fetch ${url}`)
      console.time(`buffer ${url}`)
      const image = await res.buffer()
      console.timeEnd(`buffer ${url}`)
      console.time(`find_faces ${url}`)
      const img_faces = await compare.find_faces(image)
      console.timeEnd(`find_faces ${url}`)
      console.log(`finished, found ${img_faces.length} faces in ${url}`)
      console.log(memoryUsage())

      console.time(`find matches ${url}`)
      const matches = img_faces.some(face => compare.face_match(profile_face, face.descriptor))
      console.timeEnd(`find matches ${url}`)
      console.log(`${url} matches: ${matches}`)
      return { url, matches, id: tweet.id }
    } catch (error) {
      console.error('error caught', error);
      return { url, matches: false }
    }
  }

  const matches = await Promise.all(params.tweets.map(match_tweet))
  await jobs.add_processed(client, params.job, matches) 

  return { results: `processed ${matches.length} tweets, found ${matches.filter(i => i.matches).length} faces that match profile image.`}
}

exports.twitter_search = twitter_search
exports.compare_images = compare_images
exports.schedule_search = schedule_search