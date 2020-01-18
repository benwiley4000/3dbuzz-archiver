# 3dbuzz-archiver

In January 2020 the 3D tutorials website [3D Buzz](https://www.3dbuzz.com/) shut down and released decades worth of video tutorials for free via their website. However downloading it all before the predictable discontinuation of those free files would prove to be a difficult task.. we were given an HTML page with a seemingly endless list of links each pointing to a zip archive containing a fragment of 3dbuzz's online archives.

So I decided to write some code to download all those zip files and combine them together into one huge zip file archive. This proved to be pretty complicated due to the sheer volume of data involved, but I got the job done. By the time I got this all working the archives were already taken offline but you can still torrent the files!

Once unzipped you'll have a nicely organized directory with subdirectories for each of the lesson series (multipart archives are combined together into the proper shared directories). I've also included the goodbye web page as a modified HTML file which links directly to those directories on your disc so you can browse and view the content all from your web browser. Just double-click 3dbuzz.html to get started.

## Getting the archives

SHORT VERSION:

If you just want the finished product (all the unzipped files) then you can just download [3dbuzz.torrent](3dbuzz.torrent). You'll need a bit more than 220GB of free space to download all the files! However you can also select which subdirectories you want and leave the rest.

LONG VERSION:

You'll need even more free space for this... almost twice as much as to just download the torrent (~ 440GB). You really might need to use an external disc.

If the above torrent isn't working well for you or you just want to do it yourself, note that the network-downloading step will no longer work since the archive was taken offline. In order to get around this you should download the series of zip archives via [this torrent](https://drive.google.com/uc?export=download&id=1bljXeR1xv9TphXj4zpeypyYDVDtkpk1e).

1. Clone this git repository and cd into it.

2. Place the torrented zip files into a directory called `.cache` inside the top-level directory of the cloned repository (this will be ignored by git, don't worry). This will take up 220GB on the disc where the git repository lives. Alternatively you can your cache directory elsewhere and specify the path in your `.env` file via:

```
CACHE_FOLDER_LOCATION=/path/to/.cache
```

(For more details, see [`.env.example`](.env.example)).

3. Before you start the archiver program (which will take like 6 hours or more potentially) you should specify some env config for where the output zip and the temp working directory will go .. if you don't it will all go into the same directory as the repository but you might not want this. Again, see [`.env.example`](.env.example)) for the `OUTPUT_ZIP_DIRECTORY` and `TEMP_ZIP_WORK_DIR` variables. Note that the temp working directory will be temporarily filled with all the file content that will eventually end up in the final zip archive, but it will all be deleted from disc as it is being written to the final zip archive, so combined these two targets will never take up more than about 220 GB.

4. `./3dbuzz-archiver` will start the process. You don't need to do anything.. just make sure your computer won't go to sleep (while you probably should go to sleep). There will be progress bars for the total loading time as well as individual file reads and writes, but trust me, it's kind of boring to watch.

5. Eventually you'll end up with `3dbuzz.zip` which will need to be unzipped somewhere of course. At this point make sure you've saved everything properly in the archive (hint: you can open up the zip in a preview UI and check FAILED_FETCHES.log... there should be too files missing about an XNA tutorial, but that's it).

6. If it's good, you can go ahead and delete the `.cache` directory which you don't need. I mean, if you have enough disc space, I would wait to do that, but if not you can delete that before you unzip your files onto the same disc.

7. The regular `unzip` tool isn't gonna work, and your zip UI might use that under the hood. `unzip` is limited to 4GB zip files.. ours is 210GB! You can use the `jar` or `fastjar` tool instead, which works basically the same. `fastjar -xvf 3dbuzz.zip` will create a new directory called `3dbuzz/`. It will take awhile though!

6. Finally if that all works well, you can delete the `.cache` directory if you haven't, and your `3dbuzz.zip` if you don't want that either. Now you're only using 220GB.

But as I said, just torrenting it will be faster.
