# ep-with-features
After cloning 
`bin/run.sh`

Go to setting.json and change
`minify = false`
`maxAge = 0`

Install plugins 
`npm install ep_align ep_auth_session ep_copy_paste_images ep_copy_paste_select_all ep_countable ep_font_color ep_font_size ep_headings2 ep_print ep_set_title_on_pad  ep_who_did_what`

Install dependencies of created plugin ep_comments_page
`cd plugins\ep_comments_page\static\js`
`npm install`
Then back to main dir and 
`node .\src\node\server.js`
Paste api key from to CB Rabind 
