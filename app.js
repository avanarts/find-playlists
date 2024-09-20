const querystring = require('querystring');
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const redis = require('redis');


const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const AUTH_CODE = process.env.AUTH_CODE;
let ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
const code = AUTH_CODE;


const redirect_uri = 'https://spotify.com';
const scope = 'user-read-private user-read-email playlist-read-private';
const authEndpoint = 'https://accounts.spotify.com/authorize';
const prompt = require('prompt-sync')({sigint:true}); 




let playlistArray = [];


const redisClient = redis.createClient();

async function connectRedis() {
    if (!redisClient.isOpen) {
        await redisClient.connect();
    }
}

function getCache (key) {
    return redisClient.get(key);
}


async function setCache (key, value) {
    await redisClient.set(key, value, {EX: 3600}, (err) => {
        if (err) console.error('Error in setting data:', err);
    });
}

connectRedis().then(() => {
    confirmSong();
});


if (!AUTH_CODE) {
    getAuth();
}

function getAuth() {
    const queryParams = querystring.stringify({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: scope,
        redirect_uri: redirect_uri,
    });
    
    //this generates a url for the user to authorize the app for use
    const url = `${authEndpoint}?${queryParams}`;
    console.log('Go to this URL to authorize the app:', url);

    const value = prompt('Enter your Auth Code Here: ').toString();

    updateENV('AUTH_CODE', value)

    if (!ACCESS_TOKEN) {
        getToken();
    }

    return value
}



async function updateENV (key, value) {

    //split into array
    const ENV = fs.readFileSync("./.env", "utf8").split(os.EOL);

    const targetKey = ENV.indexOf(ENV.find(line => {
        return line.match(new RegExp(key))
    }))

    ENV.splice(targetKey, 1, `${key}=${value}`)

    fs.writeFileSync('./.env', ENV.join(os.EOL))
}



//exchange auth code for access token
async function getToken() {
    console.log('Retrieving token...')

    let body = new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirect_uri
    });

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: "POST",
            body: body.toString(),
            headers: {
                'Authorization': 'Basic ' + credentials,
                'content-type': 'application/x-www-form-urlencoded'
            }
        })

        const data = await response.json();
        
        updateENV('ACCESS_TOKEN', data.access_token)
        if (!REFRESH_TOKEN) {
            updateENV('REFRESH_TOKEN', data.refresh_token)
        }
        return data;
    } catch (err) {
        console.log(`An error was encountered: ${err.message}`)
    }
}



async function refreshToken() {
    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN
    })
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: "POST",
            body: body.toString(),
            headers: {
                'Authorization': 'Basic ' + credentials,
                'content-type': 'application/x-www-form-urlencoded'
            }
            })
            const data = await response.json()
            await updateENV('ACCESS_TOKEN', data.access_token)
            return data.access_token;
    } catch (err) {
        console.log(`An error was encountered: ${err.message}`)
    }

}


async function reattemptSearch(song, artist) {
    const newToken = await refreshToken();
    ACCESS_TOKEN = newToken;

    const params = new URLSearchParams({
        q: `artist:${artist} track:${song}`,
        type: 'track',
        limit: 5
    });

    const url = `https://api.spotify.com/v1/search?${params.toString()}`

    try {
        const response = await fetch(url, {
            headers: {
                Authorization: 'Bearer ' + ACCESS_TOKEN
            }
        })

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Error response:', errorData);
                throw new Error(`Request failed with status ${response.status}`)
            }

            const data = await response.json();
            return data;

    } catch (err) {
        console.log(`Unfortunately, an error was encountered: ${err.message}`)
    }
}


async function searchSong() {

    let song = prompt('Song: ').toString();
    let artist = prompt('Artist: ').toString();
    
    const params = new URLSearchParams({
        q: `artist:${artist} track:${song}`,
        type: 'track',
        limit: 5
    });
    const url = `https://api.spotify.com/v1/search?${params.toString()}`
    console.log('Searching for song...')
    try {
        const response = await fetch(url, {
        headers: {
            Authorization: 'Bearer ' + ACCESS_TOKEN
        }
       })

        if (response.status === 401) {
            console.log('Updating Environment...')
            await refreshToken();
            return await reattemptSearch(song, artist)
        }

        if (!response.ok && response.status !== 400 && response.status !== 401) {
            console.error('Error response:', response);
            throw new Error(`Request failed with status ${response.status}`)
        }


        const data = await response.json();
        return data;

    } catch (err) {
        console.log(`Unfortunately, an error was encountered: ${err.message}`)
    }
    
}

let storedSong

async function confirmSong() {
    const data = await searchSong();
    console.log(`Song: ${data.tracks.items[0].name}`);
    console.log(`Album: ${data.tracks.items[0].album.name}`);
    console.log(`Artist: ${data.tracks.items[0].album.artists[0].name}`)

    let userInput = prompt('Is this song correct? Please enter Y or N: ')
    if (userInput === 'Y') {
        storedSong = data.tracks.items[0].name.toLowerCase()
        await processSelection()
    } else {
        await confirmSong()
    }
    await redisClient.disconnect();
    process.exit();
}


async function processSelection() {
    await fetchPlaylists()
    await getPlaylistItems(playlistArray)
    await searchPlaylist(playlistItems)
}


async function fetchPlaylists (offset = 0) {

    const cachedData = await getCache('playlistArray')
    console.log('Fetching playlists...')

   if (cachedData) {
        playlistArray = JSON.parse(cachedData)
        return playlistArray
    }

    let limit = 50;
    let URL = `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`
    const response = await fetch(URL, {
        headers: {
            Authorization: 'Bearer ' + ACCESS_TOKEN
        }
    })
    if (!response.ok) {
        console.error('Failed to fetch playlists', response.statusText);
        return playlistArray
    }

    const data = await response.json();

    
    playlistArray = playlistArray.concat(data.items.map(item => ({
        name: item.name,
        id: item.id
    })))

    if (data.next) {
        offset += limit;
        return fetchPlaylists(offset)
    } else {
        await setCache('playlistArray', JSON.stringify(playlistArray))
        return playlistArray
    }
}


let playlistItems = [];
async function getPlaylistItems(playlists, offset = 0) {

    let limit = 50
    const cachedData = await getCache('allTracks')
    if (cachedData) {
        playlistItems = JSON.parse(cachedData)
        return playlistItems
    }

    
    for (const playlist of playlists) {
        console.log(`Fetching tracks from ${playlist.name}`)
        await getItems(playlist, limit, offset)
    }

    console.log("Fetched all tracks.")


    await setCache('allTracks', JSON.stringify(playlistItems))
    //to do, need to only return certain items
    return playlistItems

}

async function getItems(playlist, limit, offset = 0) {
    let URL = `https://api.spotify.com/v1/playlists/${playlist.id}/tracks?limit=${limit}&offset=${offset}`
            const response = await fetch(URL, {
                headers: {
                    Authorization: 'Bearer ' + ACCESS_TOKEN
                }
            })
            if (!response.ok) {
                console.error('Failed to fetch tracks', response.statusText);
            }
    const data = await response.json();

    playlistItems = playlistItems.concat(data.items.map(item => ({
        id: item.track.id,
        name: item.track.name,
        artist: item.track.artists[0].name,
        playlist: playlist.name
    })))

    if (data.next) {
        offset += limit
        await getItems(playlist, limit, offset)
    }
}


async function searchPlaylist(tracks) {

    let songResults = []
     tracks.forEach((track) => {
        if (storedSong == track.name.toLowerCase()) {
            songResults.push(track.playlist)
        }
     })

     if (songResults.length === 0) {
        console.log('This song was not located in any of your playlists.')
     } else {
        console.log(`
This song is located in the following playlists: 

${songResults}`)
     }


console.log(`---+---+---+---`)
    let userInput = prompt('Would you like to try again? Please enter Y or N: ')
        if (userInput == 'Y') {
            await confirmSong()
        }
    return songResults
}