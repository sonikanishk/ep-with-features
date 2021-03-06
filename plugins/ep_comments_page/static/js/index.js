'use strict';

/* TODO:
- lable reply textarea
- Make the chekbox appear above the suggested changes even when activated
*/

const _ = require('ep_etherpad-lite/static/js/underscore');
const browser = require('ep_etherpad-lite/static/js/browser');
const commentBoxes = require('ep_comments_page/static/js/commentBoxes');
const commentIcons = require('ep_comments_page/static/js/commentIcons');
const commentL10n = require('ep_comments_page/static/js/commentL10n');
const events = require('ep_comments_page/static/js/copyPasteEvents');
const moment = require('ep_comments_page/static/js/moment-with-locales.min');
const newComment = require('ep_comments_page/static/js/newComment');
const padcookie = require('ep_etherpad-lite/static/js/pad_cookie').padcookie;
const preCommentMark = require('ep_comments_page/static/js/preCommentMark');
const getCommentIdOnFirstPositionSelected = events.getCommentIdOnFirstPositionSelected;
const hasCommentOnSelection = events.hasCommentOnSelection;
const Security = require('ep_etherpad-lite/static/js/security');
const axios = require('./node_modules/axios/index')
// const settings = require('ep_etherpad-lite/static/js/database')
//const db = require('../../../ep_etherpad-lite/node/db/DB');

const cssFiles = [
  'ep_comments_page/static/css/comment.css',
  'ep_comments_page/static/css/commentIcon.css',
];

const UPDATE_COMMENT_LINE_POSITION_EVENT = 'updateCommentLinePosition';

const parseMultiline = (text) => {
  if (!text) return text;
  text = JSON.stringify(text);
  return text.substr(1, (text.length - 2));
};

/* ********************************************************************
 *                         ep_comments Plugin                         *
 ******************************************************************** */

// Container
const EpComments = function (context) {
  this.container = null;
  this.padOuter = null;
  this.padInner = null;
  this.ace = context.ace;

  // Required for instances running on weird ports
  // This probably needs some work for instances running on root or not on /p/
  const loc = document.location;
  const port = loc.port === '' ? (loc.protocol === 'https:' ? 443 : 80) : loc.port;
  const url = `${loc.protocol}//${loc.hostname}:${port}/comment`;
  this.socket = io.connect(url);

  this.padId = clientVars.padId;
  this.comments = [];
  this.commentReplies = {};
  this.mapFakeComments = [];
  this.mapOriginalCommentsId = [];
  this.shouldCollectComment = false;
  this.init();
  this.preCommentMarker = preCommentMark.init(this.ace);
};

// Init Etherpad plugin comment pads
EpComments.prototype.init = function () {
  const self = this;
  moment.locale(html10n.getLanguage());

  // Init prerequisite
  this.findContainers();
  this.insertContainers(); // Insert comment containers in sidebar

  // Init icons container
  commentIcons.insertContainer();

  // Get all comments
  this.getComments((comments) => {
    if (!$.isEmptyObject(comments)) {
      this.setComments(comments);
      this.collectComments();
    }
  });

  this.getCommentReplies((replies) => {
    if (!$.isEmptyObject(replies)) {
      this.commentReplies = replies;
      this.collectCommentReplies();
    }
    this.commentRepliesListen();
    this.commentListen();
  });

  // Init add push event
  this.pushComment('add', (commentId, comment) => {
    this.setComment(commentId, comment);
    this.collectCommentsAfterSomeIntervalsOfTime();
  });

  // When language is changed, we need to reload the comments to make sure
  // all templates are localized
  html10n.bind('localized', () => {
    // Fall back to 'en' if moment.js doesn't support the language.
    moment.locale([html10n.getLanguage(), 'en']);
    this.localizeExistingComments();
  });

  // Recalculate position when editor is resized
  $('#settings input, #skin-variant-full-width').on('change', (e) => {
    this.setYofComments();
  });
  this.padInner.contents().on(UPDATE_COMMENT_LINE_POSITION_EVENT, (e) => {
    this.setYofComments();
  });
  $(window).resize(_.debounce(() => { this.setYofComments(); }, 100));

  // On click comment icon toolbar
  $('.addComment').on('click', (e) => {
    e.preventDefault(); // stops focus from being lost
    this.displayNewCommentForm();
  });

  // Import for below listener : we are using this.container.parent() so we include
  // events on both comment-modal and sidebar

  // Listen for events to delete a comment
  // All this does is remove the comment attr on the selection
  this.container.parent().on('click', '.comment-delete', async function () {
    const commentId = $(this).closest('.comment-container')[0].id;
    try {
      await new Promise((resolve, reject) => {
        self.socket.emit('deleteComment', {
          padId: self.padId,
          commentId,
          authorId: clientVars.userId,
        }, (errMsg) => errMsg ? reject(new Error(errMsg)) : resolve());
      });
    } catch (err) {
      if (err.message !== 'unauth') throw err; // Let the uncaught error handler handle it.
      $.gritter.add({
        title: html10n.translations['ep_comments_page.error'] || 'Error',
        text: html10n.translations['ep_comments_page.error.delete_unauth'] ||
          'You cannot delete other users comments!',
        class_name: 'error',
      });
      return;
    }
    self.deleteComment(commentId);
    const padOuter = $('iframe[name="ace_outer"]').contents();
    const padInner = padOuter.find('iframe[name="ace_inner"]');
    const selector = `.${commentId}`;
    const ace = self.ace;

    ace.callWithAce((aceTop) => {
      const repArr = aceTop.ace_getRepFromSelector(selector, padInner);
      // rep is an array of reps.. I will need to iterate over each to do something meaningful..
      $.each(repArr, (index, rep) => {
        // I don't think we need this nested call
        ace.callWithAce((ace) => {
          ace.ace_performSelectionChange(rep[0], rep[1], true);
          ace.ace_setAttributeOnSelection('comment', 'comment-deleted');
          // Note that this is the correct way of doing it, instead of there being
          // a commentId we now flag it as "comment-deleted"
        });
      });
    }, 'deleteCommentedSelection', true);
  });

  // Listen for events to edit a comment
  // Here, it adds a form to edit the comment text
  this.container.parent().on('click', '.comment-edit', function () {
    const $commentBox = $(this).closest('.comment-container');
    $commentBox.addClass('editing');

    const textBox = self.findCommentText($commentBox).last();

    // if edit form not already there
    if (textBox.siblings('.comment-edit-form').length === 0) {
      // add a form to edit the field
      const data = {};
      data.text = textBox.text();
      const content = $('#editCommentTemplate').tmpl(data);
      // localize the comment/reply edit form
      commentL10n.localize(content);
      // insert form
      textBox.before(content);
    }
  });

  // submit the edition on the text and update the comment text
  this.container.parent().on('click', '.comment-edit-submit', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $commentBox = $(this).closest('.comment-container');
    const $commentForm = $(this).closest('.comment-edit-form');
    const commentId = $commentBox.data('commentid');
    const commentText = $commentForm.find('.comment-edit-text').val();
    const data = {};
    data.commentId = commentId;
    data.padId = clientVars.padId;
    data.commentText = commentText;
    data.authorId = clientVars.userId;

    try {
      await new Promise((resolve, reject) => {
        self.socket.emit('updateCommentText', data,
          (errMsg) => errMsg ? reject(new Error(errMsg)) : resolve());
      });
    } catch (err) {
      if (err.message !== 'unauth') throw err; // Let the uncaught error handler handle it.
      $.gritter.add({
        title: html10n.translations['ep_comments_page.error'] || 'Error',
        text: html10n.translations['ep_comments_page.error.edit_unauth'] ||
          'You cannot edit other users comments!',
        class_name: 'error',
      });
      return;
    }
    $commentForm.remove();
    $commentBox.removeClass('editing');
    self.updateCommentBoxText(commentId, commentText);

    // although the comment or reply was saved on the data base successfully, it needs
    // to update the comment or comment reply variable with the new text saved
    self.setCommentOrReplyNewText(commentId, commentText);
  });

  // hide the edit form and make the comment author and text visible again
  this.container.parent().on('click', '.comment-edit-cancel', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $commentBox = $(this).closest('.comment-container');
    const textBox = self.findCommentText($commentBox).last();
    textBox.siblings('.comment-edit-form').remove();
    $commentBox.removeClass('editing');
  });

  // Listen for include suggested change toggle
  this.container.parent().on('change', '.suggestion-checkbox', function () {
    const parentComment = $(this).closest('.comment-container');
    const parentSuggest = $(this).closest('.comment-reply');

    if ($(this).is(':checked')) {
      const commentId = parentComment.data('commentid');
      const padOuter = $('iframe[name="ace_outer"]').contents();
      const padInner = padOuter.find('iframe[name="ace_inner"]');

      const currentString = padInner.contents().find(`.${commentId}`).html();

      parentSuggest.find('.from-value').html(currentString);
      parentSuggest.find('.suggestion').show();
    } else {
      parentSuggest.find('.suggestion').hide();
    }
  });

  // User accepts or revert a change
  this.container.parent().on('submit', '.comment-changeTo-form', function (e) {
    e.preventDefault();
    const data = self.getCommentData();
    ///console.log(data);
    const commentEl = $(this).closest('.comment-container');
    data.commentId = commentEl.data('commentid');
    const padOuter = $('iframe[name="ace_outer"]').contents();
    const padInner = padOuter.find('iframe[name="ace_inner"]').contents();

    // Are we reverting a change?
    
    const isRevert = commentEl.hasClass('change-accepted');
    let newString =
      isRevert ? $(this).find('.from-value').html() : $(this).find('.to-value').html();

    // In case of suggested change is inside a reply, the parentId is different from the commentId
    // (=replyId)
    const parentId = $(this).closest('.sidebar-comment').data('commentid');
    // Nuke all that aren't first lines of this comment
    padInner.find(`.${parentId}:not(:first)`).html('');

    const padCommentSpan = padInner.find(`.${parentId}`).first();
    newString = newString.replace(/(?:\r\n|\r)/g, '<br />');

    // Write the new pad contents
    padCommentSpan.html(newString);

    if (isRevert) {
      // Tell all users this change was reverted
      self.socket.emit('revertChange', data, () => { });
      self.showChangeAsReverted(data.commentId);
    } else {
      // Tell all users this change was accepted
      self.socket.emit('acceptChange', data, () => { });
      // Update our own comments container with the accepted change
      self.showChangeAsAccepted(data.commentId);
    }

    // TODO: we need ace editor to commit the change so other people get it
    // currently after approving or reverting, you need to do other thing on the pad
    // for ace to commit
  });

  // When input reply is focused we display more option
  this.container.parent().on('focus', '.comment-content', function (e) {
    $(this).closest('.new-comment').addClass('editing');
  });
  // When we leave we reset the form option to its minimal (only input)
  this.container.parent().on('mouseleave', '.comment-container', function (e) {
    $(this).find('.suggestion-checkbox').prop('checked', false);
    $(this).find('.new-comment').removeClass('editing');
  });

  // When a reply get submitted
  this.container.parent().on('submit', '.new-comment', function (e) {
    e.preventDefault();

    const data = self.getCommentData();
    data.commentId = $(this).closest('.comment-container').data('commentid');
    data.reply = $(this).find('.comment-content').val();
    data.changeTo = $(this).find('.to-value').val() || null;
    data.changeFrom = $(this).find('.from-value').text() || null;
    self.socket.emit('addCommentReply', data, () => {
      self.getCommentReplies((replies) => {
        self.commentReplies = replies;
        self.collectCommentReplies();

        // Once the new reply is displayed, we clear the form
        $('iframe[name="ace_outer"]').contents().find('.new-comment').removeClass('editing');
      });
    });

    $(this).trigger('reset_reply');
  });
  this.container.parent().on('reset_reply', '.new-comment', function (e) {
    // Reset the form
    $(this).find('.comment-content').val('');
    $(this).find(':focus').blur();
    $(this).find('.to-value').val('');
    $(this).find('.suggestion-checkbox').prop('checked', false);
    $(this).removeClass('editing');
  });
  // When click cancel reply
  this.container.parent().on('click', '.btn-cancel-reply', function (e) {
    $(this).closest('.new-comment').trigger('reset_reply');
  });


  // Enable and handle cookies
  if (padcookie.getPref('comments') === false) {
    this.padOuter.find('#comments, #commentIcons').removeClass('active');
    $('#options-comments').attr('checked', 'unchecked');
    $('#options-comments').attr('checked', false);
  } else {
    $('#options-comments').attr('checked', 'checked');
  }

  $('#options-comments').on('change', () => {
    const checked = $('#options-comments').is(':checked');
    padcookie.setPref('comments', checked);
    this.padOuter.find('#comments, #commentIcons').toggleClass('active', checked);
    $('body').toggleClass('comments-active', checked);
    $('iframe[name="ace_outer"]').contents().find('body').toggleClass('comments-active', checked);
  });

  // Check to see if we should show already..
  $('#options-comments').trigger('change');

  // TODO - Implement to others browser like, Microsoft Edge, Opera, IE
  // Override  copy, cut, paste events on Google chrome and Mozilla Firefox.
  // When an user copies a comment and selects only the span, or part of it, Google chrome
  // does not copy the classes only the styles, for example:
  // <comment class='comment'><span>text to be copied</span></comment>
  // As the comment classes are not only used for styling we have to add these classes when it
  // pastes the content
  // The same does not occur when the user selects more than the span, for example:
  // text<comment class='comment'><span>to be copied</span></comment>
  if (browser.chrome || browser.firefox) {
    this.padInner.contents().on('copy', (e) => {
      events.addTextOnClipboard(
        e, this.ace, this.padInner, false, this.comments, this.commentReplies);
    });

    this.padInner.contents().on('cut', (e) => {
      events.addTextOnClipboard(e, this.ace, this.padInner, true);
    });

    this.padInner.contents().on('paste', (e) => {
      events.saveCommentsAndReplies(e);
    });
  }
};

EpComments.prototype.findCommentText = function ($commentBox) {
  const isReply = $commentBox.hasClass('sidebar-comment-reply');
  if (isReply) return $commentBox.find('.comment-text');
  return $commentBox.find('.compact-display-content .comment-text, ' +
    '.full-display-content .comment-title-wrapper .comment-text');
};
// This function is useful to collect new comments on the collaborators
EpComments.prototype.collectCommentsAfterSomeIntervalsOfTime = async function () {
  await new Promise((resolve) => window.setTimeout(resolve, 300));
  this.collectComments();

  let countComments = Object.keys(this.comments).length;
  const padOuter = $('iframe[name="ace_outer"]').contents();
  this.padOuter = padOuter;
  this.padInner = padOuter.find('iframe[name="ace_inner"]');
  let padComment = this.padInner.contents().find('.comment');
  if (countComments <= padComment.length) return;

  await new Promise((resolve) => window.setTimeout(resolve, 1000));
  this.collectComments();
  countComments = Object.keys(this.comments).length;
  padComment = this.padInner.contents().find('.comment');
  if (countComments <= padComment.length) return;

  await new Promise((resolve) => window.setTimeout(resolve, 3000));
  this.collectComments();
  countComments = Object.keys(this.comments).length;
  padComment = this.padInner.contents().find('.comment');
  if (countComments <= padComment.length) return;

  await new Promise((resolve) => window.setTimeout(resolve, 9000));
  this.collectComments();
};

// Insert comments container on element use for linenumbers
EpComments.prototype.findContainers = function () {
  const padOuter = $('iframe[name="ace_outer"]').contents();
  this.padOuter = padOuter;
  this.padInner = padOuter.find('iframe[name="ace_inner"]');
  this.outerBody = padOuter.find('#outerdocbody');
};

// Collect Comments and link text content to the comments div
EpComments.prototype.collectComments = function (callback) {
  const self = this;
  const container = this.container;
  const comments = this.comments;
  const padComment = this.padInner.contents().find('.comment');
  //console.log(padComment);
  //padComment += this.padInner.contents().find('.comment1');

  padComment.each(function (it) {
    const $this = $(this);
    const cls = $this.attr('class');
    // console.log(cls);
    const classCommentId = /(?:^| )(c-[A-Za-z0-9]*)/.exec(cls);
    var commentId = (classCommentId) ? classCommentId[1] : null;
    if (!commentId) return;

    self.padInner.contents().find('#innerdocbody').addClass('comments');

    var comment = comments[commentId];
    const previd = commentId;
    if(!comment){
      commentId += " comment1";
    }
    comment = comments[commentId];
    const commentElm = container.find(`#${commentId}`);
    if (comment) {
      comment.data.changeFrom = parseMultiline(comment.data.changeFrom);
      // If comment is not in sidebar insert it
      if (commentElm.length === 0) {
        self.insertComment(previd, comment.data, it);
      }
      // localize comment element
      commentL10n.localize(commentElm);
    }
    const prevCommentElm = commentElm.prev();
    let commentPos = 0;

    if (prevCommentElm.length !== 0) {
      const prevCommentPos = prevCommentElm.css('top');
      const prevCommentHeight = prevCommentElm.innerHeight();

      commentPos = parseInt(prevCommentPos) + prevCommentHeight + 30;
    }

    commentElm.css({ top: commentPos });
  });

  // HOVER SIDEBAR COMMENT
  let hideCommentTimer;
  this.container.on('mouseover', '.sidebar-comment', (e) => {
    // highlight comment
    clearTimeout(hideCommentTimer);
    commentBoxes.highlightComment(e.currentTarget.id, e);
  }).on('mouseout', '.sidebar-comment', (e) => {
    // do not hide directly the comment, because sometime the mouse get out accidently
    hideCommentTimer = setTimeout(() => {
      commentBoxes.hideComment(e.currentTarget.id);
    }, 1000);
  });

  // HOVER OR CLICK THE COMMENTED TEXT IN THE EDITOR
  // hover event
  this.padInner.contents().on('mouseover', '.comment', function (e) {
    if (container.is(':visible')) { // not on mobile
      clearTimeout(hideCommentTimer);
      const commentId = self.commentIdOf(e);
      commentBoxes.highlightComment(commentId, e, $(this));
    }
  });

  // click event
  this.padInner.contents().on('click', '.comment', function (e) {
    // console.log("came")
    const commentId = self.commentIdOf(e);
    commentBoxes.highlightComment(commentId, e, $(this));
  });

  this.padInner.contents().on('mouseleave', '.comment', (e) => {
    const commentOpenedByClickOnIcon = commentIcons.isCommentOpenedByClickOnIcon();
    // only closes comment if it was not opened by a click on the icon
    if (!commentOpenedByClickOnIcon && container.is(':visible')) {
      hideCommentTimer = setTimeout(() => {
        self.closeOpenedComment(e);
      }, 1000);
    }
  });
  this.padInner.contents().on('mouseover', '.comment1', function (e) {
    if (container.is(':visible')) { // not on mobile
      clearTimeout(hideCommentTimer);
      const commentId = self.commentIdOf(e);
      commentBoxes.highlightComment(commentId, e, $(this));
    }
  });

  // click event
  this.padInner.contents().on('click', '.comment1', function (e) {
    // console.log("came")
    const commentId = self.commentIdOf(e);
    commentBoxes.highlightComment(commentId, e, $(this));
  });

  this.padInner.contents().on('mouseleave', '.comment1', (e) => {
    const commentOpenedByClickOnIcon = commentIcons.isCommentOpenedByClickOnIcon();
    // only closes comment if it was not opened by a click on the icon
    if (!commentOpenedByClickOnIcon && container.is(':visible')) {
      hideCommentTimer = setTimeout(() => {
        self.closeOpenedComment(e);
      }, 1000);
    }
  });

  this.addListenersToCloseOpenedComment();

  this.setYofComments();
  if (callback) callback();
};

EpComments.prototype.addListenersToCloseOpenedComment = function () {
  // we need to add listeners to the different iframes of the page
  $(document).on('touchstart click', (e) => {
    this.closeOpenedCommentIfNotOnSelectedElements(e);
  });
  this.padOuter.find('html').on('touchstart click', (e) => {
    this.closeOpenedCommentIfNotOnSelectedElements(e);
  });
  this.padInner.contents().find('html').on('touchstart click', (e) => {
    this.closeOpenedCommentIfNotOnSelectedElements(e);
  });
};

// Close comment that is opened
EpComments.prototype.closeOpenedComment = function (e) {
  const commentId = this.commentIdOf(e);
  commentBoxes.hideComment(commentId);
};

// Close comment if event target was outside of comment or on a comment icon
EpComments.prototype.closeOpenedCommentIfNotOnSelectedElements = function (e) {
  // Don't do anything if clicked on the allowed elements:
  // any of the comment icons
  if (commentIcons.shouldNotCloseComment(e) || commentBoxes.shouldNotCloseComment(e)) return;
  // All clear, can close the comment
  this.closeOpenedComment(e);
};

// Collect Comments and link text content to the comments div
EpComments.prototype.collectCommentReplies = function (callback) {
  $.each(this.commentReplies, (replyId, reply) => {
    const commentId = reply.commentId;
    if (commentId) {
      // tell comment icon that this comment has 1+ replies
      commentIcons.commentHasReply(commentId);

      const existsAlready = $('iframe[name="ace_outer"]').contents().find(`#${replyId}`).length;
      if (existsAlready) return;

      reply.replyId = replyId;
      reply.text = reply.text || '';
      reply.date = moment(reply.timestamp).fromNow();
      reply.formattedDate = new Date(reply.timestamp).toISOString();

      const content = $('#replyTemplate').tmpl(reply);
      if (reply.author !== clientVars.userId) {
        $(content).find('.comment-edit').remove();
      }
      // localize comment reply
      commentL10n.localize(content);
      const repliesContainer =
        $('iframe[name="ace_outer"]').contents().find(`#${commentId} .comment-replies-container`);
      repliesContainer.append(content);
    }
  });
};

EpComments.prototype.commentIdOf = function (e) {
  const cls = e.currentTarget.classList;
  const classCommentId = /(?:^| )(c-[A-Za-z0-9]*)/.exec(cls);

  return (classCommentId) ? classCommentId[1] : null;
};

// Insert comment container in sidebar
EpComments.prototype.insertContainers = function () {
  const target = $('iframe[name="ace_outer"]').contents().find('#outerdocbody');

  // Create hover modal
  target.prepend(
    $('<div>').addClass('comment-modal popup').append(
      $('<div>').addClass('popup-content comment-modal-comment')));

  // Add comments side bar container
  target.prepend($('<div>').attr('id', 'comments'));

  this.container = this.padOuter.find('#comments');
};

// Insert a comment node
EpComments.prototype.insertComment = function (commentId, comment, index) {
  
  let content = null;
  const container = this.container;
  const commentAfterIndex = container.find('.sidebar-comment').eq(index);
  
  //console.log(container);
  //console.log(commentAfterIndex);
  comment.commentId = commentId;
  //console.log(comment.commentId);
  comment.reply = true;
  content = $('#commentsTemplate').tmpl(comment);
  if (comment.author !== clientVars.userId) {
    $(content).find('.comment-actions-wrapper').addClass('hidden');
  }
  commentL10n.localize(content);

  // position doesn't seem to be relative to rep

  if (index === 0) {
    content.prependTo(container);
  } else if (commentAfterIndex.length === 0) {
    content.appendTo(container);
  } else {
    commentAfterIndex.before(content);
  }

  // insert icon
  commentIcons.addIcon(commentId, comment);
};

// Set all comments to be inline with their target REP
EpComments.prototype.setYofComments = function () {
  // for each comment in the pad
  const padOuter = $('iframe[name="ace_outer"]').contents();
  const padInner = padOuter.find('iframe[name="ace_inner"]');
  const inlineComments = this.getFirstOcurrenceOfCommentIds();
  const commentsToBeShown = [];

  $.each(inlineComments, function () {
    // classname is the ID of the comment
    const commentId = /(?:^| )(c-[A-Za-z0-9]*)/.exec(this.className);
    if (!commentId || !commentId[1]) return;
    const commentEle = padOuter.find(`#${commentId[1]}`);

    let topOffset = this.offsetTop;
    topOffset += parseInt(padInner.css('padding-top').split('px')[0]);
    topOffset += parseInt($(this).css('padding-top').split('px')[0]);

    if (commentId) {
      // adjust outer comment...
      commentBoxes.adjustTopOf(commentId[1], topOffset);
      // ... and adjust icons too
      commentIcons.adjustTopOf(commentId[1], topOffset);

      // mark this comment to be displayed if it was visible before we start adjusting its position
      if (commentIcons.shouldShow(commentEle)) commentsToBeShown.push(commentEle);
    }
  });

  // re-display comments that were visible before
  _.each(commentsToBeShown, (commentEle) => {
    commentEle.show();
  });
};

EpComments.prototype.getFirstOcurrenceOfCommentIds = function () {
  const padOuter = $('iframe[name="ace_outer"]').contents();
  const padInner = padOuter.find('iframe[name="ace_inner"]').contents();
  const commentsId = this.getUniqueCommentsId(padInner);
  const firstOcurrenceOfCommentIds =
    _.map(commentsId, (commentId) => padInner.find(`.${commentId}`).first().get(0));
  return firstOcurrenceOfCommentIds;
};

EpComments.prototype.getUniqueCommentsId = function (padInner) {
  const inlineComments = padInner.find('.comment');
  const commentsId = _.map(inlineComments, (inlineComment) => {
    const commentId = /(?:^| )(c-[A-Za-z0-9]*)/.exec(inlineComment.className);
    // avoid when it has a '.comment' that it has a fakeComment class 'fakecomment-123' yet.
    if (commentId && commentId[1]) return commentId[1];
  });
  return _.uniq(commentsId);
};

// Indicates if all comments are on the correct Y position, and don't need to
// be adjusted
EpComments.prototype.allCommentsOnCorrectYPosition = function () {
  // for each comment in the pad
  const padOuter = $('iframe[name="ace_outer"]').contents();
  const padInner = padOuter.find('iframe[name="ace_inner"]');
  const inlineComments = padInner.contents().find('.comment');
  let allCommentsAreCorrect = true;

  $.each(inlineComments, function () {
    const y = this.offsetTop;
    const commentId = /(?:^| )(c-[A-Za-z0-9]*)/.exec(this.className);
    if (commentId && commentId[1]) {
      if (!commentBoxes.isOnTop(commentId[1], y)) { // found one comment on the incorrect place
        allCommentsAreCorrect = false;
        return false; // to break loop
      }
    }
  });

  return allCommentsAreCorrect;
};

EpComments.prototype.localizeExistingComments = function () {
  const self = this;
  const padComments = this.padInner.contents().find('.comment');
  const comments = this.comments;

  padComments.each((key, it) => {
    const $this = $(it);
    const cls = $this.attr('class');
    const classCommentId = /(?:^| )(c-[A-Za-z0-9]*)/.exec(cls);
    const commentId = (classCommentId) ? classCommentId[1] : null;

    if (commentId != null) {
      const commentElm = self.container.find(`#${commentId}`);
      const comment = comments[commentId];

      // localize comment element...
      commentL10n.localize(commentElm);
      // ... and update its date
      comment.data.date = moment(comment.data.timestamp).fromNow();
      comment.data.formattedDate = new Date(comment.data.timestamp).toISOString();
      $(commentElm).find('.comment-created-at').html(comment.data.date);
    }
  });
};

// Set comments content data
EpComments.prototype.setComments = function (comments) {
  for (const [commentId, comment] of Object.entries(comments)) {
    this.setComment(commentId, comment);
  }
};

// Set comment data
EpComments.prototype.setComment = function (commentId, comment) {
  const comments = this.comments;
  comment.date = moment(comment.timestamp).fromNow();
  comment.formattedDate = new Date(comment.timestamp).toISOString();

  if (comments[commentId] == null) comments[commentId] = {};
  comments[commentId].data = comment;
};

// commentReply = ['c-reply-123', commentDataObject]
// commentDataObject = {author:..., name:..., text:..., ...}
EpComments.prototype.setCommentReply = function (commentReply) {
  const commentReplies = this.commentReplies;
  const replyId = commentReply[0];
  commentReplies[replyId] = commentReply[1];
};

// set the text of the comment or comment reply
EpComments.prototype.setCommentOrReplyNewText = function (commentOrReplyId, text) {
  if (this.comments[commentOrReplyId]) {
    this.comments[commentOrReplyId].data.text = text;
  } else if (this.commentReplies[commentOrReplyId]) {
    this.commentReplies[commentOrReplyId].text = text;
  }
};

// Get all comments
EpComments.prototype.getComments = function (callback) {
  const req = { padId: this.padId };

  this.socket.emit('getComments', req, (res) => {
    callback(res.comments);
  });
};

EpComments.prototype.getPersona = function (callback) {
  const req = { padId: this.padId };
  //console.log(req);
  this.socket.emit('getPersona', req, (res) => {
    //console.log(res.persona);
    // return res.persona;
    callback(res.persona);
  });
};

// Get all comment replies
EpComments.prototype.getCommentReplies = function (callback) {
  const req = { padId: this.padId };
  this.socket.emit('getCommentReplies', req, (res) => {
    callback(res.replies);
  });
};

EpComments.prototype.getCommentData = function () {
  const data = {};

  // Insert comment data
  data.padId = this.padId;
  data.comment = {};
  data.comment.author = clientVars.userId;
  data.comment.name = pad.myUserInfo.name;
  data.comment.timestamp = new Date().getTime();

  // If client is anonymous
  if (data.comment.name === undefined) {
    data.comment.name = clientVars.userAgent;
  }

  return data;
};

// Delete a pad comment
EpComments.prototype.deleteComment = function (commentId) {
  $('iframe[name="ace_outer"]').contents().find(`#${commentId}`).remove();
};

const cloneLine = (line) => {
  const padOuter = $('iframe[name="ace_outer"]').contents();
  const padInner = padOuter.find('iframe[name="ace_inner"]');

  const lineElem = $(line.lineNode);
  const lineClone = lineElem.clone();
  const innerOffset = $(padInner).offset().left;
  const innerPadding = parseInt(padInner.css('padding-left') + lineElem.offset().left);
  const innerdocbodyMargin = innerOffset + innerPadding || 0;
  padInner.contents().find('body').append(lineClone);
  lineClone.css({ position: 'absolute' });
  lineClone.css(lineElem.offset());
  lineClone.css({ left: innerdocbodyMargin });
  lineClone.width(lineElem.width());

  return lineClone;
};

let isHeading = function (index) {
  const attribs = this.documentAttributeManager.getAttributesOnLine(index);
  for (let i = 0; i < attribs.length; i++) {
    if (attribs[i][0] === 'heading') {
      const value = attribs[i][1];
      i = attribs.length;
      return value;
    }
  }
  return false;
};

const getXYOffsetOfRep = (rep) => {
  let selStart = rep.selStart;
  let selEnd = rep.selEnd;
  // make sure end is after start
  if (selStart[0] > selEnd[0] || (selStart[0] === selEnd[0] && selStart[1] > selEnd[1])) {
    selEnd = selStart;
    selStart = _.clone(selStart);
  }

  let startIndex = 0;
  const endIndex = selEnd[1];
  const lineIndex = selEnd[0];
  if (selStart[0] === selEnd[0]) {
    startIndex = selStart[1];
  }

  const padInner = $('iframe[name="ace_outer"]').contents().find('iframe[name="ace_inner"]');

  // Get the target Line
  const startLine = rep.lines.atIndex(selStart[0]);
  const endLine = rep.lines.atIndex(selEnd[0]);
  const clone = cloneLine(endLine);
  let lineText = Security.escapeHTML($(endLine.lineNode).text()).split('');
  lineText.splice(endIndex, 0, '</span>');
  lineText.splice(startIndex, 0, '<span id="selectWorker">');
  lineText = lineText.join('');

  const heading = isHeading(lineIndex);
  if (heading) {
    lineText = `<${heading}>${lineText}</${heading}>`;
  }
  $(clone).html(lineText);

  // Is the line visible yet?
  if ($(startLine.lineNode).length !== 0) {
    const worker = $(clone).find('#selectWorker');
    // A standard generic offset'
    let top = worker.offset().top + padInner.offset().top + parseInt(padInner.css('padding-top'));
    let left = worker.offset().left;
    // adjust position
    top += worker[0].offsetHeight;

    if (left < 0) {
      left = 0;
    }
    // Remove the clone element
    $(clone).remove();
    return [left, top];
  }
};
EpComments.prototype.displayNewCommentForm5 = function (rep) {
  
  this.createNewCommentFormIfDontExist(rep);

  setTimeout(() => {
    const position = getXYOffsetOfRep(rep);
    newComment.showNewCommentPopup5(position);
  });
};
EpComments.prototype.displayNewCommentForm4 = function () {

  const rep = {};
  const ace = this.ace;
  ace.callWithAce((ace) => {
    const saveRep = ace.ace_getRep();
    const padlines = ace.editor.exportText().split('\n');
    rep.lines = saveRep.lines;
    const x = saveRep.selEnd[0];
    const y = saveRep.selEnd[1];
    if(y===0) {
      const len = padlines[x-1].length
      saveRep.selEnd = [x-1,len]
    }
    rep.selEnd = saveRep.selEnd;
    rep.selStart = saveRep.selEnd;
    
  });

  
  this.createNewCommentFormIfDontExist(rep);
  const position = getXYOffsetOfRep(rep);
  newComment.showNewCommentPopup4(position);

};
EpComments.prototype.displayNewCommentForm3 = function (rep) {
  
  this.createNewCommentFormIfDontExist(rep);

  setTimeout(() => {
    const position = getXYOffsetOfRep(rep);
    newComment.showNewCommentPopup3(position);
  });
};

EpComments.prototype.displayNewCommentForm2 = function (rep) {
  
  this.createNewCommentFormIfDontExist(rep);
  //this.createNewCommentFormIfDontExist2(rep);
  setTimeout(() => {
    const position = getXYOffsetOfRep(rep);
    newComment.showNewCommentPopup2(position);
  });

  // Adjust focus on the form
  $('#newComment2').find('.comment-content').focus();

};

EpComments.prototype.displayNewCommentForm1 = function () {
  const rep = {};
  const ace = this.ace;
  // ace.callWithAce((ace) => {
  //   const padlines = ace.editor.exportText().split('\n');
  //   const saveRep = ace.ace_getRep();

  //   rep.lines = saveRep.lines;

  //   rep.selEnd = saveRep.selEnd;
  //   rep.selStart = saveRep.selEnd[0];
  // }, 'saveCommentedSelection', true);
  ace.callWithAce((ace) => {
    // console.log(ace)
    const saveRep = ace.ace_getRep();
    const padlines = ace.editor.exportText().split('\n');
    rep.lines = saveRep.lines;
    const x = saveRep.selEnd[0];
    const y = saveRep.selEnd[1];
    if(y===0) {
      const len = padlines[x-1].length
      saveRep.selEnd = [x-1,len]
    }
    rep.selEnd = saveRep.selEnd;
    rep.selStart = saveRep.selEnd;
    
  }, 'saveCommentedSelection', true);
  console.log(rep);

  this.createNewCommentFormIfDontExist(rep);
  const position = getXYOffsetOfRep(rep);
  newComment.showNewCommentPopup1(position);
};

EpComments.prototype.displayNewCommentForm = function () {
  const rep = {};
  const ace = this.ace;

  ace.callWithAce((ace) => {
    const padlines = ace.editor.exportText().split('\n');
    const saveRep = ace.ace_getRep();

    rep.lines = saveRep.lines;

    rep.selEnd = [saveRep.selEnd[0], padlines[saveRep.selEnd[0]].length];
    rep.selStart = [saveRep.selEnd[0], rep.selEnd[1] - 1];
  }, 'saveCommentedSelection', true);
  
  const selectedText = this.getSelectedText(rep);
  // // we have nothing selected, do nothing
  // const noTextSelected = (selectedText.length === 0);
  // if (noTextSelected) {
    // $.gritter.add({
    //   text: html10n.translations['ep_comments_page.add_comment.hint'] ||
    //     'Please first select the text to comment',
    // });
  //   return;
  // }

  this.createNewCommentFormIfDontExist(rep);

  // Write the text to the changeFrom form
  $('#newComment').find('.from-value').text(selectedText);

  // Display form
  setTimeout(() => {
    const position = getXYOffsetOfRep(rep);
    newComment.showNewCommentPopup(position);
  });

  // Check if the first element selected is visible in the viewport
  const $firstSelectedElement = this.getFirstElementSelected();
  //console.log($firstSelectedElement);
  const firstSelectedElementInViewport = this.isElementInViewport($firstSelectedElement);
  //console.log(firstSelectedElementInViewport);
  if (!firstSelectedElementInViewport) {
    this.scrollViewportIfSelectedTextIsNotVisible($firstSelectedElement);
  }

  // Adjust focus on the form
  $('#newComment').find('.comment-content').focus();
};

EpComments.prototype.scrollViewportIfSelectedTextIsNotVisible = function ($firstSelectedElement) {
  // Set the top of the form to be the same Y as the target Rep
  const y = $firstSelectedElement.offsetTop;
  const padOuter = $('iframe[name="ace_outer"]').contents();
  padOuter.find('#outerdocbody').scrollTop(y); // Works in Chrome
  padOuter.find('#outerdocbody').parent().scrollTop(y); // Works in Firefox
};

EpComments.prototype.isElementInViewport = function (element) {
  const elementPosition = element.getBoundingClientRect();
  const outerdocbody = $('iframe[name="ace_outer"]').contents().find('#outerdocbody');
  const scrolltop = (outerdocbody.scrollTop() ||
    // Works only on Firefox:
    outerdocbody.parent().scrollTop());
  // position relative to the current viewport
  const elementPositionTopOnViewport = elementPosition.top - scrolltop;
  const elementPositionBottomOnViewport = elementPosition.bottom - scrolltop;

  const $aceOuter = $('iframe[name="ace_outer"]');
  const aceOuterHeight = $aceOuter.height();
  const aceOuterPaddingTop = this.getIntValueOfCSSProperty($aceOuter, 'padding-top');

  const clientHeight = aceOuterHeight - aceOuterPaddingTop;

  const elementAboveViewportTop = elementPositionTopOnViewport < 0;
  const elementBelowViewportBottom = elementPositionBottomOnViewport > clientHeight;

  return !(elementAboveViewportTop || elementBelowViewportBottom);
};

EpComments.prototype.getIntValueOfCSSProperty = function ($element, property) {
  const valueString = $element.css(property);
  return parseInt(valueString) || 0;
};

EpComments.prototype.getFirstElementSelected = function () {
  let element;

  this.ace.callWithAce((ace) => {
    const rep = ace.ace_getRep();
    const line = rep.lines.atIndex(rep.selStart[0]);
    const key = `#${line.key}`;
    const padOuter = $('iframe[name="ace_outer"]').contents();
    const padInner = padOuter.find('iframe[name="ace_inner"]').contents();
    element = padInner.find(key);
  }, 'getFirstElementSelected', true);

  return element[0];
};

// Indicates if user selected some text on editor
EpComments.prototype.checkNoTextSelected = function (rep) {
  const noTextSelected = ((rep.selStart[0] === rep.selEnd[0]) &&
    (rep.selStart[1] === rep.selEnd[1]));

  return noTextSelected;
};

// Create form to add comment
EpComments.prototype.createNewCommentFormIfDontExist2 = function (rep) {
  const data = this.getCommentData();
  
  // If a new comment box doesn't already exist, create one
  data.changeFrom = parseMultiline(this.getSelectedText(rep));
  //console.log(data.changeFrom);
  newComment.insertNewCommentPopupIfDontExist2(data, (comment, index) => {
    if (comment.changeTo) {
      data.comment.changeFrom = comment.changeFrom;
      data.comment.changeTo = comment.changeTo;
    }
    data.comment.text = comment.text;
    //console.log(data);
    this.saveComment(data, rep);
  });
};

EpComments.prototype.createNewCommentFormIfDontExist = function (rep) {
  
  const data = this.getCommentData();
  // If a new comment box doesn't already exist, create one
  data.changeFrom = parseMultiline(this.getSelectedText(rep));
  //console.log(data.changeFrom);
  newComment.insertNewCommentPopupIfDontExist(data, (comment, index) => {
    if (comment.changeTo) {
      data.comment.changeFrom = comment.changeFrom;
      data.comment.changeTo = comment.changeTo;
    }
    data.comment.text = comment.text;
    //console.log(data);
    
    this.saveComment(data, rep);
  });
};

// Get a string representation of the text selected on the editor
EpComments.prototype.getSelectedText = function (rep) {
  // The selection representation looks like this if it starts with the fifth character in the
  // second line and ends at (but does not include) the third character in the eighth line:
  //     rep.selStart = [1, 4]; // 2nd line 5th char
  //     rep.selEnd = [7, 2]; // 8th line 3rd char
  const selectedTextLines = [];
  const lastLine = this.getLastLine(rep.selStart[0], rep);
  for (let lineNumber = rep.selStart[0]; lineNumber <= lastLine; ++lineNumber) {
    const line = rep.lines.atIndex(lineNumber);
    const selStartsAfterLine = rep.selStart[0] > lineNumber ||
      (rep.selStart[0] === lineNumber && rep.selStart[1] >= line.text.length);
    if (selStartsAfterLine) continue; // Nothing in this line is selected.
    const selEndsBeforeLine = rep.selEnd[0] < lineNumber ||
      (rep.selEnd[0] === lineNumber && rep.selEnd[1] <= 0);
    if (selEndsBeforeLine) continue; // Nothing in this line is selected.
    const selStartsBeforeLine = rep.selStart[0] < lineNumber || rep.selStart[1] < 0;
    const posStart = selStartsBeforeLine ? 0 : rep.selStart[1];
    const selEndsAfterLine = rep.selEnd[0] > lineNumber || rep.selEnd[1] > line.text.length;
    const posEnd = selEndsAfterLine ? line.text.length : rep.selEnd[1];
    // If the selection includes the very beginning of line, and the line has a line marker, it
    // means the line marker was selected as well. Exclude it from the selected text.
    selectedTextLines.push(
      line.text.substring((posStart === 0 && this.lineHasMarker(line)) ? 1 : posStart, posEnd));
  }
  return selectedTextLines.join('\n');
};

EpComments.prototype.getLastLine = function (firstLine, rep) {
  let lastLineSelected = rep.selEnd[0];

  if (lastLineSelected > firstLine) {
    // Ignore last line if the selected text of it it is empty
    if (this.lastLineSelectedIsEmpty(rep, lastLineSelected)) {
      lastLineSelected--;
    }
  }
  return lastLineSelected;
};

EpComments.prototype.lastLineSelectedIsEmpty = function (rep, lastLineSelected) {
  const line = rep.lines.atIndex(lastLineSelected);
  // when we've a line with line attribute, the first char line position
  // in a line is 1 because of the *, otherwise is 0
  const firstCharLinePosition = this.lineHasMarker(line) ? 1 : 0;
  const lastColumnSelected = rep.selEnd[1];

  return lastColumnSelected === firstCharLinePosition;
};

EpComments.prototype.lineHasMarker = function (line) {
  return line.lineMarker === 1;
};

// Save comment
EpComments.prototype.saveComment = function (data, rep) {
    //console.log(data);
  this.socket.emit('addComment', data, (commentId, comment) => {
    //console.log(comment);
    comment.commentId = commentId;
    this.ace.callWithAce((ace) => {
      // we should get rep again because the document might have changed..
      // details at https://github.com/ether/ep_comments/issues/133
      //rep = ace.ace_getRep();
      //console.log(data.num);
      if(data.num === 1) {
        commentId += " comment1";
        // console.log(commentId);
        // // this.padInner.contents().find('.ace-line').addClass('commentsasas');
        // //console.log(rep);
        // ace.ace_performSelectionChange(rep.selStart, rep.selEnd, true);
        // ace.ace_setAttributeOnSelection('comment', commentId);
      }
      ace.ace_performSelectionChange(rep.selStart, rep.selEnd, true);
      ace.ace_setAttributeOnSelection('comment', commentId);
    }, 'insertComment', true);

    this.setComment(commentId, comment);
    this.collectComments();
  });
};

// commentData = {c-newCommentId123: data:{author:..., date:..., ...},
//                c-newCommentId124: data:{...}}
EpComments.prototype.saveCommentWithoutSelection = function (padId, commentData) {
  const data = this.buildComments(commentData);
  this.socket.emit('bulkAddComment', padId, data, (comments) => {
    this.setComments(comments);
    this.shouldCollectComment = true;
  });
};

EpComments.prototype.buildComments = function (commentsData) {
  const comments =
    _.map(commentsData, (commentData, commentId) => this.buildComment(commentId, commentData.data));
  return comments;
};

// commentData = {c-newCommentId123: data:{author:..., date:..., ...}, ...
EpComments.prototype.buildComment = function (commentId, commentData) {
  const data = {};
  data.padId = this.padId;
  data.commentId = commentId;
  data.text = commentData.text;
  data.changeTo = commentData.changeTo;
  data.changeFrom = commentData.changeFrom;
  data.name = commentData.name;
  data.timestamp = parseInt(commentData.timestamp);

  return data;
};

EpComments.prototype.getMapfakeComments = function () {
  return this.mapFakeComments;
};

// commentReplyData = {c-reply-123:{commentReplyData1}, c-reply-234:{commentReplyData1}, ...}
EpComments.prototype.saveCommentReplies = function (padId, commentReplyData) {
  const data = this.buildCommentReplies(commentReplyData);
  this.socket.emit('bulkAddCommentReplies', padId, data, (replies) => {
    _.each(replies, (reply) => {
      this.setCommentReply(reply);
    });
    this.shouldCollectComment = true; // force collect the comment replies saved
  });
};

EpComments.prototype.buildCommentReplies = function (repliesData) {
  const replies = _.map(repliesData, (replyData) => this.buildCommentReply(replyData));
  return replies;
};

// take a replyData and add more fields necessary. E.g. 'padId'
EpComments.prototype.buildCommentReply = function (replyData) {
  const data = {};
  data.padId = this.padId;
  data.commentId = replyData.commentId;
  data.text = replyData.text;
  data.changeTo = replyData.changeTo;
  data.changeFrom = replyData.changeFrom;
  data.replyId = replyData.replyId;
  data.name = replyData.name;
  data.timestamp = parseInt(replyData.timestamp);

  return data;
};

// Listen for comment
EpComments.prototype.commentListen = function () {
  const socket = this.socket;
  socket.on('pushAddCommentInBulk', () => {
    this.getComments((allComments) => {
      if (!$.isEmptyObject(allComments)) {
        // we get the comments in this format {c-123:{author:...}, c-124:{author:...}}
        // but it's expected to be {c-123: {data: {author:...}}, c-124:{data:{author:...}}}
        // in this.comments
        const commentsProcessed = {};
        _.map(allComments, (comment, commentId) => {
          commentsProcessed[commentId] = {};
          commentsProcessed[commentId].data = comment;
        });
        this.comments = commentsProcessed;
        this.collectCommentsAfterSomeIntervalsOfTime(); // here we collect on the collaborators
      }
    });
  });
};

// Listen for comment replies
EpComments.prototype.commentRepliesListen = function () {
  this.socket.on('pushAddCommentReply', (replyId, reply) => {
    this.getCommentReplies((replies) => {
      if (!$.isEmptyObject(replies)) {
        this.commentReplies = replies;
        this.collectCommentReplies();
      }
    });
  });
};

EpComments.prototype.updateCommentBoxText = function (commentId, commentText) {
  const $comment = this.container.parent().find(`[data-commentid='${commentId}']`);
  const textBox = this.findCommentText($comment);
  textBox.text(commentText);
};

EpComments.prototype.ChangePersona = async function (persona, padId) {
  const self = this;
  const data = {};
  data.persona = persona;
  data.padId = padId;
  // console.log(data);
  try {
    await new Promise((resolve, reject) => {
      self.socket.emit('updatePersona', data,
        (errMsg) => errMsg ? reject(new Error(errMsg)) : resolve());
    });
  } catch (err) {
    if (err.message !== 'unauth') throw err; // Let the uncaught error handler handle it.
    $.gritter.add({
      title: html10n.translations  ['Error'],
      text: html10n.translations
        ['You cannot edit other users comments!'],
      class_name: 'error',
    });
    return;
  }
};

EpComments.prototype.showChangeAsAccepted = function (commentId) {
  const self = this;

  // Get the comment
  const comment = this.container.parent().find(`[data-commentid='${commentId}']`);
  // Revert other comment that have already been accepted
  comment.closest('.sidebar-comment')
    .find('.comment-container.change-accepted').addBack('.change-accepted')
    .each(function () {
      $(this).removeClass('change-accepted');
      const data = { commentId: $(this).attr('data-commentid'), padId: self.padId };
      self.socket.emit('revertChange', data, () => { });
    });

  // this comment get accepted
  comment.addClass('change-accepted');
};

EpComments.prototype.showChangeAsReverted = function (commentId) {
  // Get the comment
  const comment = this.container.parent().find(`[data-commentid='${commentId}']`);
  comment.removeClass('change-accepted');
};

// Push comment from collaborators
EpComments.prototype.pushComment = function (eventType, callback) {
  const socket = this.socket;

  socket.on('textCommentUpdated', (commentId, commentText) => {
    this.updateCommentBoxText(commentId, commentText);
  });

  socket.on('commentDeleted', (commentId) => {
    this.deleteComment(commentId);
  });

  socket.on('changeAccepted', (commentId) => {
    this.showChangeAsAccepted(commentId);
  });

  socket.on('changeReverted', (commentId) => {
    this.showChangeAsReverted(commentId);
  });

  // On collaborator add a comment in the current pad
  if (eventType === 'add') {
    socket.on('pushAddComment', (commentId, comment) => {
      callback(commentId, comment);
    });
  } else if (eventType === 'addCommentReply') {
    socket.on('pushAddCommentReply', (replyId, reply) => {
      callback(replyId, reply);
    });
  }
};

/* ********************************************************************
 *                           Etherpad Hooks                           *
 ******************************************************************** */
const apis = ['sentence analysis','headline','paraphrase', 'spellcheck'];
const persona = ["Innocent", "Everyman", "Hero", "Outlaw", "Explorer", "Creator", "Ruler", "Magician", "Lover", "Caregiver", "Jester", "Sage"]
var curpersona = persona[0];
var lastPageUpOrDownEvent;
const TooSoon = () => {
  const delay = 300;

  if (!lastPageUpOrDownEvent) {
    lastPageUpOrDownEvent = Date.now();
    return false;
  }

  const nextValidTime = lastPageUpOrDownEvent + delay;
  if (Date.now() >= nextValidTime) {
    lastPageUpOrDownEvent = Date.now();
    return false;
  } else {
    return true;
  }
}
const hooks = {

  // Init pad comments

  postAceInit: (hookName, context, cb) => {
    // const ace = context.ace
    // ace.callWithAce((ace) => {
    //   const padlines = ace.editor.exportText().split('\n');
    //   console.log(padlines)
    //   console.log(ace.editor.getFormattedCode())
    //   console.log(ace.editor.getFrame())
    //   console.log(ace.editor)
    //   console.log(ace.editor)
      
    //   // console.log(ace.editor.importText());
    //   // console.log(ace.editor.importAText());
      
    // })
    
    if (!pad.plugins) pad.plugins = {};
    const Comments = new EpComments(context);
    pad.plugins.ep_comments_page = Comments;
    // console.log(clientVars)
  
    if (!$('#editorcontainerbox').hasClass('flex-layout')) {
      $.gritter.add({
        title: 'Error',
        text: 'Ep_comments_page: Please upgrade to etherpad 1.8.3 ' +
          'for this plugin to work correctly',
        sticky: true,
        class_name: 'error',
      });
    }
    const hs = $('.api-selection, #api-selection');
    hs.on('change', function () {
      const value = $(this).val();
      const intValue = parseInt(value, 10);
      if (!_.isNaN(intValue)) {
        //console.log(intValue);
        context.ace.callWithAce((ace) => {
          if (intValue == 5) {
            const rep = ace.ace_getRep();
            
            if (rep.selStart[0] === rep.selEnd[0] && rep.selStart[1] === rep.selEnd[1]) {
              var padlines = ace.editor.exportText().split('\n');
              var result = [];
              //console.log(padlines);
              for (var i = 0; i < padlines.length; i++) {
                const pre = [];
                let flag = 0;
                if (padlines[i][0]) {
                  if (padlines[i][0] === '*') {
                    // padlines[i].splice(0,1);
                    let newpadline = padlines[i].substr(1, padlines[i].length - 1);
                    padlines[i] = newpadline;
                    flag = 1;
                  }
                }

                for (var j = 0; j < padlines[i].length; j++) {
                  if (padlines[i][j] === '.' || padlines[i][j] === ':' || padlines[i][j] === '<' || padlines[i][j] === '>' || padlines[i][j] === '(' || padlines[i][j] === ')' || padlines[i][j] === ',' || padlines[i][j] === '{' || padlines[i][j] === '}' || padlines[i][j] === '[' || padlines[i][j] === ']' || padlines[i][j] === '&' || padlines[i][j] === ';' || padlines[i][j] === '?' || padlines[i][j] === '!' || padlines[i][j] === '~' || padlines[i][j] === '|') {
                    if (j === 0) prev[j] = 1;
                    else pre[j] = pre[j - 1] + 1;
                  }
                  else {
                    if (j === 0 && flag === 0) pre[j] = 0;
                    else if (j === 0 && flag === 1) pre[j] = 1;
                    else pre[j] = pre[j - 1];
                  }
                }
                //console.log(pre);
                if (padlines[i]) {
                  axios.get('https://506f9a11a2a1.ngrok.io/', { params: { line: i, query: padlines[i] } }).then(res => {

                    result[res.data.line] = (res.data.output);
                    var complete_string = "";
                    if (result[res.data.line]) {
                      for (var k = 0; k < result[res.data.line].length; k++) {
                        complete_string += result[res.data.line][k] + " ";
                      }
                    }
                    if (complete_string) {
                      var expected = complete_string.split(/[ .:;?!~,`"&|()<>{}\[\]\r\n/\\]+/);
                      var current = padlines[res.data.line].split(/[ .:;?!~,`"&|()<>{}\[\]\r\n/\\]+/);
                      var sum = 0;
                      if (current && expected) {
                        for (var k = 0; k < expected.length && k < current.length; k++) {
                          var start = [], end = [];
                          start[0] = parseInt(res.data.line);
                          start[1] = sum + pre[sum];
                          end[0] = parseInt(res.data.line);
                          end[1] = sum + current[k].length + pre[sum + current[k].length];

                          if (expected[k] != current[k]) {
                            const data = {};

                            // // // Insert comment data
                            data.padId = clientVars.padId;
                            data.comment = {};
                            data.comment.author = ace.ace_getAuthor();
                            data.comment.name = "";
                            data.comment.timestamp = new Date().getTime();

                            // // // If client is anonymous
                            if (data.comment.name === undefined) {
                              data.comment.name = clientVars.userAgent;
                            }
                            data.changeFrom = current[k];
                            data.comment.changeFrom = current[k];
                            data.comment.changeTo = expected[k];
                            data.comment.text = "";
                            data.commentId = "";
                            var rep = {};
                            rep.selStart = start;
                            rep.selEnd = end;
                            // console.log(data);
                            // console.log(rep);
                            pad.plugins.ep_comments_page.saveComment(data, rep);

                            // console.log("current line1 : (" + (res.data.line) + ","+ sum  +") current word : " + current[k]);
                            // console.log("current line2 : (" + (res.data.line) +","+ (sum+current[k].length)  +") corrected word : " + expected[k]);
                          }
                          sum += current[k].length + 1;
                        }
                      }
                    }
                  })
                }
              }

            }
            else {
              const rep = ace.ace_getRep();
              var padlines = ace.editor.exportText().split('\n');
              var result = [];
              for (var i = rep.selStart[0]; i <= rep.selEnd[0]; i++) {
                const pre = [];
                for (var j = 0; j < padlines[i].length; j++) {
                  if (padlines[i][j] === '.' || padlines[i][j] === ':' || padlines[i][j] === '<' || padlines[i][j] === '>' || padlines[i][j] === '(' || padlines[i][j] === ')' || padlines[i][j] === ',' || padlines[i][j] === '{' || padlines[i][j] === '}' || padlines[i][j] === '[' || padlines[i][j] === ']' || padlines[i][j] === '&' || padlines[i][j] === ';' || padlines[i][j] === '?' || padlines[i][j] === '!' || padlines[i][j] === '~' || padlines[i][j] === '|') {
                    if (j === 0) prev[j] = 1;
                    else pre[j] = pre[j - 1] + 1;
                  }
                  else {
                    if (j === 0) pre[j] = 0;
                    else pre[j] = pre[j - 1];
                  }
                }
                // console.log(pre);
                if (padlines[i]) {
                  axios.get('https://506f9a11a2a1.ngrok.io/', { params: { line: i, query: padlines[i] } }).then(res => {

                    result[res.data.line] = (res.data.output);
                    var complete_string = "";
                    // console.log(result[res.data.line]);
                    // console.log(padlines[res.data.line]);

                    if (result[res.data.line]) {
                      for (var k = 0; k < result[res.data.line].length; k++) {
                        complete_string += result[res.data.line][k] + " ";
                      }
                    }
                    if (complete_string) {
                      var expected = complete_string.split(/[ .:;?!~,`"&|()<>{}\[\]\r\n/\\]+/);
                      var current = padlines[res.data.line].split(/[ .:;?!~,`"&|()<>{}\[\]\r\n/\\]+/);
                      var sum = 0;
                      if (current && expected) {
                        for (var k = 0; k < expected.length && k < current.length; k++) {
                          var start = [], end = [];
                          start[0] = parseInt(res.data.line);
                          start[1] = sum + pre[sum];
                          end[0] = parseInt(res.data.line);
                          end[1] = sum + current[k].length + pre[sum + current[k].length - 1];

                          if (expected[k] != current[k]) {
                            const data = {};

                            // // // Insert comment data
                            data.padId = clientVars.padId;
                            data.comment = {};
                            data.comment.author = ace.ace_getAuthor();
                            data.comment.name = "";
                            data.comment.timestamp = new Date().getTime();

                            // // // If client is anonymous
                            if (data.comment.name === undefined) {
                              data.comment.name = clientVars.userAgent;
                            }
                            data.changeFrom = current[k];
                            data.comment.changeFrom = current[k];
                            data.comment.changeTo = expected[k];
                            data.comment.text = "";
                            data.commentId = "";
                            var rep = {};
                            rep.selStart = start;
                            rep.selEnd = end;
                            // console.log(data);
                            // console.log(rep);
                            pad.plugins.ep_comments_page.saveComment(data, rep);

                            // console.log("current line1 : (" + (res.data.line) + ","+ sum  +") current word : " + current[k]);
                            // console.log("current line2 : (" + (res.data.line) +","+ (sum+current[k].length)  +") corrected word : " + expected[k]);
                          }
                          sum += current[k].length + 1;
                        }
                      }
                    }
                  })
                }
              }
            }

          }
          else if(intValue === 4) {
            var rep = ace.ace_getRep();

            // console.log(rep);
            // console.log(clientVars);
            
            function get_paraphrased(line,padline) {
              return axios.get('https://61d8ee160925.ngrok.io/', { params: { line: line, query: padline,num:10 } }).then((res) => {                
                return res.data;
              })
            }
            function afterdel() {
              console.log("::");
              // $('#newComment4').removeClass('popup-show');
              $('#newComment4').remove();
              $('#newComment').remove();
              $('#newComment3').remove();
              $('#newComment2').remove();
            }
            var afterData = function (line,padline) { 

              pad.plugins.ep_comments_page.displayNewCommentForm4();
              // setTimeout(afterdel,3000);
              return get_paraphrased(line,padline).then((data) => {
                afterdel()
                $(function () {
                  data = data.output;
                  const dataa = [{"id":data[0]},{"id":data[1]},{"id":data[2]},{"id":data[3]},
                                 {"id":data[4]},{"id":data[5]},{"id":data[6]},{"id":data[7]},
                                 {"id":data[8]},{"id":data[9]}];
                  var userList = '${id}'
                  $.template('userlist', userList);
                  $("#dataa0" ).empty();
                  $("#dataa1" ).empty();
                  $("#dataa2" ).empty();
                  $("#dataa3" ).empty();
                  $("#dataa4" ).empty();
                  $("#dataa5" ).empty();
                  $("#dataa6" ).empty();
                  $("#dataa7" ).empty();
                  $("#dataa8" ).empty();
                  $("#dataa9" ).empty();
                  //console.log(dataa);
                  if (dataa) {
                    if (dataa[0]) $.tmpl('userlist', dataa[0]).appendTo('#dataa0');
                    if (dataa[1]) $.tmpl('userlist', dataa[1]).appendTo('#dataa1');
                    if (dataa[2]) $.tmpl('userlist', dataa[2]).appendTo('#dataa2');
                    if (dataa[3]) $.tmpl('userlist', dataa[3]).appendTo('#dataa3'); 
                    if (dataa[4]) $.tmpl('userlist', dataa[4]).appendTo('#dataa4'); 
                    if (dataa[5]) $.tmpl('userlist', dataa[5]).appendTo('#dataa5'); 
                    if (dataa[6]) $.tmpl('userlist', dataa[6]).appendTo('#dataa6'); 
                    if (dataa[7]) $.tmpl('userlist', dataa[7]).appendTo('#dataa7'); 
                    if (dataa[8]) $.tmpl('userlist', dataa[8]).appendTo('#dataa8'); 
                    if (dataa[9]) $.tmpl('userlist', dataa[9]).appendTo('#dataa9'); 
                  }
                });
                
                pad.plugins.ep_comments_page.displayNewCommentForm1();
                const $allOptions = $(this).closest('#list-unstyled1')

                $("#list-unstyled1").on("click",".lilili", function() {
                  $("#showmore").addClass("rest");
                  $("#more").removeClass("rest");
                })
                $("#list-unstyled1").on("click",".lililil", function() {
                  $("#showmore").removeClass("rest");
                  $("#more").addClass("rest");
                })
                
                $("#list-unstyled1").on("click", ".lili", function () {
                  $allOptions.removeClass('selected');
                  $(this).addClass('selected');
                  $("#list-unstyled1").html("");
                  const chosen = $(this).html();
                  var padlines = ace.editor.exportText().split('\n');
                  rep = ace.ace_getRep();

                  ace.ace_replaceRange(rep.selStart, rep.selEnd, chosen);
                  rep = ace.ace_getRep();
                  ace.ace_focus(rep.selEnd);
                  $('#newComment1').remove();
                  $allOptions.toggle();
                });
              })
            };
            if (rep.selStart[0] === rep.selEnd[0] && rep.selStart[1] === rep.selEnd[1]) {
              $.gritter.add({
                text:'Please first select the text to paraphrase'
              });
            }
            else {
              const rep = ace.ace_getRep();
              const selectedText = pad.plugins.ep_comments_page.getSelectedText(rep);

              afterData(1,selectedText);
            }
          }
          else if(intValue === 3){
            
            //console.log(intValue);
            function afterdel() {
              console.log("::");
              // $('#newComment4').removeClass('popup-show');
              $('#newComment4').remove();
              $('#newComment').remove();
              $('#newComment3').remove();
              $('#newComment2').remove();
            }
            var padlines = ace.editor.exportText();
            function get_headline(lines) {
              return axios.get('https://5c04f75480b5.ngrok.io', { params: { query: lines } }).then((res) => {
                return res.data;
              })
            }
            var afterData = function () {
              pad.plugins.ep_comments_page.displayNewCommentForm4();
              return get_headline(padlines).then((data) => {
                afterdel()
                //console.log(data["The summary is"]);
                const myAuthorId = pad.getUserId();
                const padId = pad.getPadId();
                const title = data["The summary is"];
                
                const message1 = {
                  type: 'title',
                  action: 'sendTitleMessage',
                  message: title,
                  padId,
                  myAuthorId,
                };
                //console.log(message1);
                pad.collabClient.sendMessage(message1); 
                const message = data["The summary is"];
                if (!$('#input_title').is(':visible')) { 
                  if (message) {
                    window.document.title = message;
                    $('#title > h1 > a').text(message);
                    $('#input_title').val(message);
                    clientVars.ep_set_title_on_pad = {};
                    clientVars.ep_set_title_on_pad.title = message;
                  }
                }
              })
            };
            afterData();
          }
          else if (intValue === 2) {
            function get_zeroshot(lines,classes,box) {
              //console.log(classes);
              const parms = { query: lines, labels: classes , relative:box };
              console.log(parms);
              var rel = "false";
              if(box===true) rel = "true";
              return axios.get('https://219b1f5f8bbd.ngrok.io/getclasspreview', { params: { query: lines, labels: classes, relative:rel} }).then((res) => {
                return res.data;
              })
            }
            const rep = ace.ace_getRep();
            function popup() {
              return pad.plugins.ep_comments_page.displayNewCommentForm2(rep);
            }
            function truncate (num, places) {
              return Math.trunc(num * Math.pow(10, places)) / Math.pow(10, places);
            }
            const selectedText = pad.plugins.ep_comments_page.getSelectedText(rep);
            console.log(selectedText);
            if (selectedText !== "") {
              // $("#outerdocbody").css('justify-content','left');------------------
              $(document).ready(function() {   
                $('#tokenfield').tokenfield();
              });
              //-------------
              popup();
              $(".comment-edit-analyse").on("click", function () {
                const classes = $('.comment-content').val();
                const box = $('.suggestion-checkbox').prop('checked');
                console.log(classes);
                $('.comment-content').remove();
                //console.log(classes);
                //axios call on calsses and selectedtext
                var afterData = function () {
                  $("#dataaa" ).empty();
                  return get_zeroshot(selectedText, classes, box).then((data) => {
                    console.log(data);
                    const labels = data.labels;
                    const scores = data.scores;
                    //const parms = { query: lines, labels: classes };
                    const dataa = [];
                    for (var i = 0; i < labels.length; i++) {
                      const cur = { label: labels[i], score: truncate(scores[i]*100,0) };
                      dataa.push(cur);
                    }
                    //console.log(dataa);
                    //var userList = '<div>${label}</div> <div>${score}</div>';
                    $("#dataaa0" ).empty();
                    $("#dataaa1" ).empty();
                    $("#dataaa2" ).empty();
                    $("#dataaa3" ).empty();
                    $("#dataaa4" ).empty();
                    $("#dataaa5" ).empty();
                    $("#dataaa6" ).empty();
                    $("#dataaa7" ).empty();
                    $("#dataaa8" ).empty();
                    $("#dataaa9" ).empty();
                    $("#dataaa10" ).empty();
                    $("#dataaa11" ).empty();
                    $("#dataaa12" ).empty();
                    $("#dataaa13" ).empty();
                    $("#dataaa14" ).empty();
                    $("#dataaa15" ).empty();
                    $("#dataaa16" ).empty();
                    $("#dataaa17" ).empty();
                    $("#dataaa18" ).empty();
                    $("#dataaa19" ).empty();
                    
                    $.template('userlist', '<div>${label} <div style="width:100%;text-align:right">${score}%</div></div><div class="black" style="width:${score}%;height:5px;margin-bottom:10px;"></div>');
                    if (dataa[0]) $.tmpl('userlist', dataa[0]).appendTo('#dataaa0');
                    if (dataa[1]) $.tmpl('userlist', dataa[1]).appendTo('#dataaa1');
                    if (dataa[2]) $.tmpl('userlist', dataa[2]).appendTo('#dataaa2');
                    if (dataa[3]) $.tmpl('userlist', dataa[3]).appendTo('#dataaa3'); 
                    if (dataa[4]) $.tmpl('userlist', dataa[4]).appendTo('#dataaa4'); 
                    if (dataa[5]) $.tmpl('userlist', dataa[5]).appendTo('#dataaa5'); 
                    if (dataa[6]) $.tmpl('userlist', dataa[6]).appendTo('#dataaa6'); 
                    if (dataa[7]) $.tmpl('userlist', dataa[7]).appendTo('#dataaa7'); 
                    if (dataa[8]) $.tmpl('userlist', dataa[8]).appendTo('#dataaa8'); 
                    if (dataa[9]) $.tmpl('userlist', dataa[9]).appendTo('#dataaa9'); 
                    if (dataa[10]) $.tmpl('userlist', dataa[10]).appendTo('#dataaa10');
                    if (dataa[11]) $.tmpl('userlist', dataa[11]).appendTo('#dataaa11');
                    if (dataa[12]) $.tmpl('userlist', dataa[12]).appendTo('#dataaa12');
                    if (dataa[13]) $.tmpl('userlist', dataa[13]).appendTo('#dataaa13'); 
                    if (dataa[14]) $.tmpl('userlist', dataa[14]).appendTo('#dataaa14'); 
                    if (dataa[15]) $.tmpl('userlist', dataa[15]).appendTo('#dataaa15'); 
                    if (dataa[16]) $.tmpl('userlist', dataa[16]).appendTo('#dataaa16'); 
                    if (dataa[17]) $.tmpl('userlist', dataa[17]).appendTo('#dataaa17'); 
                    if (dataa[18]) $.tmpl('userlist', dataa[18]).appendTo('#dataaa18'); 
                    if (dataa[19]) $.tmpl('userlist', dataa[19]).appendTo('#dataaa19'); 
                    // for (var i = 0; i < labels.length; i++) {
                    //   console.log(dataa[i]);
                    //   $.tmpl('userList',dataa[i]).appendTo("#dataaa");
                    // }
                    $('#newComment2').remove();
                    $('#newComment3').css({"visibility":"visible"});
                    $('#inNC3').css({"opacity": "1","transform": "scale(1)"});
                    // transform: scale(1);
                    // opacity: 1;
                    // visibility: visible;
                    pad.plugins.ep_comments_page.displayNewCommentForm3(rep);
                    $("#comment-close").on("click",function () {
                      $('#newComment3').css({"visibility":"hidden"});
                      $('#inNC3').css({"opacity": "0","transform": "scale(0)"});
                      $('#newComment3').remove();
                      $('#newComment1').remove();
                    })
                  });
                }
                if(classes !== '') afterData();
                else {
                  alert("Please enter the required details")
                }

              })
              $(".comment-edit-cancel").on("click", function () {
                $('#newComment2').remove();
                $('#newComment').remove();
                $('#newComment1').remove();
                $('#newComment3').remove();
              })
            }
            else {
              $.gritter.add({
                text: 'Please first select the text to analyse'
              });
            }
          }
        }, 'ML-APIs', true);
        hs.val('dummy');
      }
    });
    //const hs = $('.api-selection, #api-selection');
    const hs1 = $('.persona-selection, #persona-selection');
    hs1.on('change', async function () {
      const value = $(this).val();
      const intValue = parseInt(value, 10);
      curpersona = persona[intValue-1];
      //console.log(curpersona);
      const padId = pad.getPadId();
      pad.plugins.ep_comments_page.ChangePersona(curpersona,padId);
    })
    var title = "title";
    if(clientVars.ep_set_title_on_pad) title = clientVars.ep_set_title_on_pad.title;
    const hs2 = $('#preview');
    var author = clientVars.userId;
    hs2.on('click', async function () {
      context.ace.callWithAce((ace) => {

        const iframe = context.ace.getFrame();
        var innerDoc = iframe.contentDocument || iframe.contentWindow.document;
        const bodyy = innerDoc.body.getElementsByTagName("iframe");
        const inner_iframe = bodyy[0];
        innerDoc = inner_iframe.contentDocument || inner_iframe.contentWindow.document;
        const innerdocbody = innerDoc.body;
        console.log(innerdocbody);
        const divs = innerdocbody.getElementsByTagName("div");
        var htmldata = ""
        for(var i=0;i<divs.length;i++) {
          htmldata += (divs[i].innerHTML) + "\n"
        }
        console.log(htmldata)

        var padlines = ace.editor.exportText();
        const rep = ace.ace_getRep();
        pad.plugins.ep_comments_page.displayNewCommentForm5(rep);
        $(".comment-edit-view").on("click", function () {
          const authorname = $('#tokenfield1').val();
          const imageurl = $('#tokenfield2').val();
          const template1 = $('#template1').prop("checked");
          const template2 = $('#template2').prop("checked");
          console.log(template1);
          console.log(template2);
          var tmp = 1;
          if(template2) tmp = 2;

          const padId = clientVars.padId;
          // console.log(imageurl);
          // console.log(authorname);
          const data = {"title":title,"content":htmldata,"authorID":authorname,"imageUrl":imageurl,"padID":padId,"template":tmp}
          console.log(data);
          if(authorname && (template1 || template2)){
            axios.post("http://localhost:1337/blogs",data).then(res=>{
              console.log(res)
              window.open(`http://localhost:3001/${res.data.id}`)
            }).catch(err=>{
              console.log(err)
            })
          }
          else{
            alert("Please enter the required details")
          }
          $('#newComment2').remove();
          $('#newComment').remove();
          $('#newComment1').remove();
          $('#newComment3').remove();
          $('#newComment4').remove();
          $('#newComment5').remove();
        })
        $(".comment-edit-cancel").on("click", function () {
          $('#newComment2').remove();
          $('#newComment').remove();
          $('#newComment1').remove();
          $('#newComment3').remove();
          $('#newComment4').remove();
          $('#newComment5').remove();
          
        })
      })
    })


    pad.plugins.ep_comments_page.getPersona((res) => {
      // console.log(res);
    })
    return cb();
  },
  aceKeyEvent: (hookName, context, cb) => {
    if (context.evt.originalEvent.key === 'Tab' && TooSoon() === false) {
      const padlines = context.rep.alltext.split('\n');
      //console.log(padlines);
      var lines = padlines[context.rep.selEnd[0]].split(/[.;?!\r\n/\\]+/);
      //console.log(lines);
      var line = lines[lines.length - 1];
      console.log(line);
      if (!line) line = "So";
      function afterdel() {
        console.log("::");
        // $('#newComment4').removeClass('popup-show');
        $('#newComment4').remove();
        $('#newComment').remove();
        $('#newComment3').remove();
        $('#newComment2').remove();
      }
      function get_next_words(line) {
        //use persona here
        return axios.get('https://46d29b46da18.ngrok.io', { params: { query: line } }).then((res) => {
          afterdel()
          console.log(JSON.parse(res.data));
          return res.data;
        })
      }
      var afterData = function () {
        pad.plugins.ep_comments_page.displayNewCommentForm4();
        return get_next_words(line).then((data) => {
          data = JSON.parse(data);
          $(function () {
            
            var data0 = data[0].id.replace('[,', '');
            var data1 = data[1].id.replace('[,', '');
            var data2 = data[2].id.replace('[,', '');
            var data3 = data[3].id.replace('[,', '');
            var data4 = data[4].id.replace('[,', '');
            
            data0 = data0.replace((/\r?\n/)," ");
            data1 = data1.replace((/\r?\n/)," ");
            data2 = data2.replace((/\r?\n/)," ");
            data3 = data3.replace((/\r?\n/)," ");
            data4 = data4.replace((/\r?\n/)," ");


            data0 = data0.replaceAll('u00a0','');
            data1 = data1.replaceAll('u00a0','');
            data2 = data2.replaceAll('u00a0','');
            data3 = data3.replaceAll('u00a0','');
            data4 = data4.replaceAll('u00a0','');

            // console.log(data0);
            // console.log(data1);
            // console.log(data2);
            // console.log(data3);
            // console.log(data4);
            
            data0 = data0.substr(1,data0.length-1);
            data1 = data1.substr(1,data1.length-1);
            data2 = data2.substr(1,data2.length-1);
            data3 = data3.substr(1,data3.length-1);
            data4 = data4.substr(1,data4.length-1);

            data[0].id = data0;
            data[1].id = data1;
            data[2].id = data2;
            data[3].id = data3;
            data[4].id = data4;
            
            var userList = '${id}'
            $.template('userlist', userList);
            if (data) {
              if (data[1]) $.tmpl('userlist', data[1]).appendTo('#data0');
              if (data[2]) $.tmpl('userlist', data[2]).appendTo('#data1');
              if (data[3]) $.tmpl('userlist', data[3]).appendTo('#data2');
            }
          });
          pad.plugins.ep_comments_page.displayNewCommentForm();
          //const $allOptions = $("#list-unstyled").children('.lili');
          const $allOptions = $(this).closest('#list-unstyled')
          //console.log($allOptions);
          $("#list-unstyled").on("click", ".lili", function () {
            $allOptions.removeClass('selected');
            $(this).addClass('selected');
            $("#list-unstyled").html("");
            const chosen = $(this).html();
            // console.log(chosen);
            const text = " " + chosen;
            var padlines = context.rep.alltext.split('\n');
            
            const rep = context.rep;
            if (padlines[rep.selEnd[0]].length > 0) {
              const end = [rep.selEnd[0], padlines[rep.selEnd[0]].length];
              const start = [rep.selEnd[0], padlines[rep.selEnd[0]].length];
              if(padlines[rep.selEnd[0]][padlines[rep.selEnd[0]].length-1] !== ' ') context.editorInfo.ace_replaceRange(start, end, text);
              else{;
                context.editorInfo.ace_replaceRange(start, end, chosen);
              }
            }
            else {
              const end = [rep.selEnd[0], padlines[rep.selEnd[0]].length];
              const start = [rep.selEnd[0], padlines[rep.selEnd[0]].length];
              context.editorInfo.ace_replaceRange(start, end, chosen);
            }
            const end = [rep.selEnd[0], padlines[rep.selEnd[0]].length];
            context.editorInfo.ace_focus(end);
            $allOptions.toggle();
            $('#newComment2').remove();
            $('#newComment').remove();
            $('#newComment1').remove();
            $('#newComment3').remove();
          });
        })
      }
      afterData();
    };
    return cb();
  },
  postToolbarInit: (hookName, args, cb) => {
    const editbar = args.toolbar;

    editbar.registerCommand('addComment', () => {
      pad.plugins.ep_comments_page.displayNewCommentForm();
    });
    // editbar.registerCommand('mlapi', () => {

    // });
    editbar.registerCommand('mlapi', (buttonName, toolbar, item) => {
      $(item.$el).after($('#ml-api'));
    });
    // editbar.registerCommand('mlapi');

    return cb();
  },

  aceEditEvent: (hookName, context, cb) => {
    if (!pad.plugins) pad.plugins = {};
    // first check if some text is being marked/unmarked to add comment to it
    const eventType = context.callstack.editEvent.eventType;
    if (eventType === 'unmarkPreSelectedTextToComment') {
      pad.plugins.ep_comments_page.preCommentMarker.handleUnmarkText(context);
    } else if (eventType === 'markPreSelectedTextToComment') {
      pad.plugins.ep_comments_page.preCommentMarker.handleMarkText(context);
    }

    if (['setup', 'setBaseText', 'importText'].includes(eventType)) return cb();

    if (context.callstack.docTextChanged && pad.plugins.ep_comments_page) {
      pad.plugins.ep_comments_page.setYofComments();
    }

    // some times on init ep_comments_page is not yet on the plugin list
    if (pad.plugins.ep_comments_page) {
      const commentWasPasted = pad.plugins.ep_comments_page.shouldCollectComment;
      const domClean = context.callstack.domClean;
      // we have to wait the DOM update from a fakeComment 'fakecomment-123' to a comment class
      // 'c-123'
      if (commentWasPasted && domClean) {
        pad.plugins.ep_comments_page.collectComments(() => {
          pad.plugins.ep_comments_page.collectCommentReplies();
          pad.plugins.ep_comments_page.shouldCollectComment = false;
        });
      }
    }

    return cb();
  },

  aceAttribsToClasses: (hookName, context, cb) => {
    // console.log(context)
    // console.log(pad)
    // console.log(context.value)
    
    if (context.key === 'comment' && context.value !== 'comment-deleted') {
      return cb(['comment', context.value]);
    }
    // only read marks made by current user
    if (context.key === preCommentMark.MARK_CLASS && context.value === clientVars.userId) {
      return cb([preCommentMark.MARK_CLASS, context.value]);
    }
    return cb();
  },

  aceEditorCSS: (hookName, context, cb) => cb(cssFiles),
};

exports.aceEditorCSS = hooks.aceEditorCSS;
exports.postAceInit = hooks.postAceInit;
exports.postToolbarInit = hooks.postToolbarInit;
exports.aceAttribsToClasses = hooks.aceAttribsToClasses;
exports.aceEditEvent = hooks.aceEditEvent;
exports.aceKeyEvent = hooks.aceKeyEvent;
// Given a CSS selector and a target element (in this case pad inner)
// return the rep as an array of array of tuples IE [[[0,1],[0,2]], [[1,3],[1,5]]]
// We have to return an array of a array of tuples because there can be multiple reps
// For a given selector
// A more sane data structure might be an object such as..
/*
0:{
  xStart: 0,
  xEnd: 1,
  yStart: 0,
  yEnd: 1
},
1:...
*/
// Alas we follow the Etherpad convention of using tuples here.
const getRepFromSelector = function (selector, container) {
  const attributeManager = this.documentAttributeManager;

  const repArr = [];

  // first find the element
  const elements = container.contents().find(selector);
  // One might expect this to be a rep for the entire document
  // However what we actually need to do is find each selection that includes
  // this comment and remove it.  This is because content can be pasted
  // Mid comment which would mean a remove selection could have unexpected consequences

  $.each(elements, (index, span) => {
    // create a rep array container we can push to..
    const rep = [[], []];

    // span not be the div so we have to go to parents until we find a div
    const parentDiv = $(span).closest('div');
    // line Number is obviously relative to entire document
    // So find out how many elements before in this parent?
    const lineNumber = $(parentDiv).prevAll('div').length;
    // We can set beginning of rep Y (lineNumber)
    rep[0][0] = lineNumber;

    // We can also update the end rep Y
    rep[1][0] = lineNumber;

    // Given the comment span, how many characters are before it?

    // All we need to know is the number of characters before .foo
    /*

    <div id="boo">
      hello
      <span class='nope'>
        world
      </span>
      are you
      <span class='foo'>
        here?
      </span>
    </div>

    */
    // In the example before the correct number would be 21
    // I guess we could do prevAll each length?
    // If there are no spans before we get 0, simples!
    // Note that this only works if spans are being used, which imho
    // Is the correct container however if block elements are registered
    // It's plausable that attributes are not maintained :(
    let leftOffset = 0;

    // If the line has a lineAttribute then leftOffset should be +1
    // Get each line Attribute on this line..
    let hasLineAttribute = false;
    const attrArr = attributeManager.getAttributesOnLine(lineNumber);
    $.each(attrArr, (attrK, value) => {
      if (value[0] === 'lmkr') hasLineAttribute = true;
    });
    if (hasLineAttribute) leftOffset++;

    $(span).prevAll('span').each(function () {
      const spanOffset = $(this).text().length;
      leftOffset += spanOffset;
    });
    rep[0][1] = leftOffset;
    rep[1][1] = rep[0][1] + $(span).text().length; // Easy!
    repArr.push(rep);
  });
  return repArr;
};

// Once ace is initialized, we set ace_doInsertHeading and bind it to the context
exports.aceInitialized = (hookName, context, cb) => {
  const editorInfo = context.editorInfo;
  isHeading = _(isHeading).bind(context);
  editorInfo.ace_getRepFromSelector = _(getRepFromSelector).bind(context);
  editorInfo.ace_getCommentIdOnFirstPositionSelected =
    _(getCommentIdOnFirstPositionSelected).bind(context);
  editorInfo.ace_hasCommentOnSelection = _(hasCommentOnSelection).bind(context);
  return cb();
};

