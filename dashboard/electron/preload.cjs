'use strict'
const { contextBridge } = require('electron')

// Nothing from Node reaches the page except this read-only description.
contextBridge.exposeInMainWorld('desktop', Object.freeze({ platform: process.platform }))
